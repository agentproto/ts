/**
 * The agent side of AIP-44 ACP, backed by the Claude Agent SDK's headless
 * `query()`.
 *
 * Implements the `@agentclientprotocol/sdk` `Agent` interface: on
 * `session/prompt` it drives `query({ prompt, options })` and relays the SDK's
 * native message stream as ACP `session/update`s (assistant text, tool calls,
 * usage). I/O stays 100% Anthropic-native — no format translation of the model
 * I/O — so the daemon spawns this like any other ACP arm.
 *
 * Session identity: ACP requires a session id at `session/new`, before any
 * `query()` has run. We generate a UUID there and PIN it via the SDK's
 * `options.sessionId` on the first turn, so our ACP session id and the SDK's
 * `session_id` are the same value — which then feeds `options.resume` on later
 * turns (agentproto resume).
 */

import type {
  AgentSideConnection,
  Agent as AcpAgent,
  AuthenticateRequest,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  McpServer,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
} from "@agentclientprotocol/sdk"
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import {
  query as sdkQuery,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { sdkMessageToUpdates, systemInitSessionId } from "./message-map.js"
import {
  buildQueryOptions,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TOOL_IDLE_TIMEOUT_MS,
  type ClaudeSdkConfig,
} from "./options.js"

/** The single SDK entry point we depend on — the headless async generator.
 *  Typed structurally and injectable so tests can drive the host with a faked
 *  message stream (no live Anthropic key required). */
export type QueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: Options
}) => AsyncIterable<SDKMessage>

interface SessionState {
  /** The pinned ACP/SDK session id. */
  readonly id: string
  /** MCP servers injected by the daemon at `session/new`. */
  readonly mcpServers: McpServer[]
  /** null until the first turn has pinned the SDK session. */
  started: boolean
  /** The SDK's own session id, adopted from the `init` message. */
  sdkSessionId: string | null
  /** In-flight turn, for cancellation. */
  prompt: AbortController | null
}

/** A message from an unknown thrown value, without an unsafe cast. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Thrown by the {@link ClaudeSdkAcpAgent}'s turn watchdog when `query()` stops
 * yielding messages: the SDK child wedged and never delivered the terminal
 * `result`, so the async iterator would otherwise never terminate. A defensive
 * safety net for an environmentally wedged child (e.g. a conflicting host env
 * leaked into the SDK subprocess), not a response-shape problem — a healthy
 * turn always reaches `result`. Distinct from a user cancel so the host
 * surfaces it as an error rather than silently reporting the turn as cancelled.
 */
export class TurnStalledError extends Error {
  constructor(public readonly idleMs: number) {
    super(
      `claude-sdk: query() produced no message for ${idleMs}ms — the model ` +
        `stream stalled and never delivered a terminal result. Aborting the ` +
        `turn to avoid a silent, zero-output hang. If this was a slow but ` +
        `healthy turn, raise CLAUDE_SDK_IDLE_TIMEOUT_MS.`,
    )
    this.name = "TurnStalledError"
  }
}

/** Pull the user's text out of an ACP prompt (its `text` content blocks). */
export function promptText(params: PromptRequest): string {
  return params.prompt
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()
}

export class ClaudeSdkAcpAgent implements AcpAgent {
  readonly #conn: AgentSideConnection
  readonly #config: ClaudeSdkConfig
  readonly #query: QueryFn
  readonly #sessions = new Map<string, SessionState>()

  constructor(
    conn: AgentSideConnection,
    config: ClaudeSdkConfig = {},
    query: QueryFn = sdkQuery,
  ) {
    this.#conn = conn
    this.#config = config
    this.#query = query
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        // Turns resume via the SDK's session store (options.resume), keyed by
        // the pinned session id — but there is no ACP `session/load` replay
        // surface, so we advertise loadSession: false.
        loadSession: false,
      },
    }
  }

  async authenticate(
    _params: AuthenticateRequest,
  ): Promise<Record<string, never>> {
    // Auth (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN, or Bedrock/Vertex/Foundry
    // env) is read from the spawn env by the SDK — no ACP-level handshake.
    return {}
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const id = crypto.randomUUID()
    this.#sessions.set(id, {
      id,
      mcpServers: params.mcpServers ?? [],
      started: false,
      sdkSessionId: null,
      prompt: null,
    })
    return { sessionId: id }
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.#sessions.get(params.sessionId)
    if (!session) throw new Error(`unknown session ${params.sessionId}`)

    // Cancel any in-flight turn for this session before starting a new one.
    session.prompt?.abort()
    const ac = new AbortController()
    session.prompt = ac

    const text = promptText(params)
    try {
      const options = buildQueryOptions({
        config: this.#config,
        abortController: ac,
        // First turn pins the id; later turns resume the SDK session.
        ...(session.started
          ? { resume: session.sdkSessionId ?? session.id }
          : { sessionId: session.id }),
        mcpServers: session.mcpServers,
      })
      session.started = true

      await this.#drive(session, text, options, ac)
    } catch (err) {
      // A watchdog stall aborts `ac` to tear down the SDK subprocess, so check
      // the stall FIRST — otherwise it would masquerade as a user cancel and be
      // silently swallowed, which is exactly the zero-output failure we fix.
      if (ac.signal.aborted && !(err instanceof TurnStalledError)) {
        session.prompt = null
        return { stopReason: "cancelled" }
      }
      // Surface the failure as a message chunk, then end the turn — better UX
      // than a bare JSON-RPC error the host may swallow.
      await this.#conn.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `\n[claude-sdk error] ${errorMessage(err)}\n`,
          },
        },
      })
      session.prompt = null
      return { stopReason: "refusal" }
    }

    const cancelled = ac.signal.aborted
    session.prompt = null
    return { stopReason: cancelled ? "cancelled" : "end_turn" }
  }

  async cancel(params: CancelNotification): Promise<void> {
    this.#sessions.get(params.sessionId)?.prompt?.abort()
  }

  /**
   * The daemon applies operator options (model, base_url) at spawn — via the
   * manifest's `bin_args_template` / `env` — then also calls this ACP config
   * hook (its default "config apply" path). Everything is already in effect,
   * so this reports our (empty) runtime-configurable set. Without it the spawn
   * fails with "Method not found: session/set_config_option".
   */
  async setSessionConfigOption(
    _params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    return { configOptions: [] }
  }

  /** No agent-specific modes; accept and ignore so a host that sets one
   *  doesn't error. */
  async setSessionMode(
    _params: SetSessionModeRequest,
  ): Promise<Record<string, never>> {
    return {}
  }

  /** Drive one `query()` turn: adopt the SDK session id from `init`, then map
   *  each SDK message to ACP updates and relay them.
   *
   *  Iteration is driven manually (rather than `for await`) so an idle watchdog
   *  can bound the wait for each next message. If the SDK child wedges mid-turn
   *  — stops yielding messages without delivering the terminal `result` and
   *  without closing (e.g. a conflicting host env leaked into the subprocess) —
   *  the watchdog aborts the turn with a {@link TurnStalledError} instead of
   *  awaiting forever with zero output. A defensive safety net; a well-behaved
   *  turn (Moonshot included, under a clean env) reaches `result` and this
   *  never fires. */
  async #drive(
    session: SessionState,
    text: string,
    options: Options,
    ac: AbortController,
  ): Promise<void> {
    const idleMs = this.#config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    const toolIdleMs = this.#config.toolIdleTimeoutMs ?? DEFAULT_TOOL_IDLE_TIMEOUT_MS
    const iterator = this.#query({ prompt: text, options })[
      Symbol.asyncIterator
    ]()
    // Once a `stream_event` has streamed this turn's prose, the terminal
    // complete `assistant` message repeats it — suppress its text so the ring
    // isn't fed the same prose twice (see message-map's suppressAssistantText).
    let sawPartial = false
    // Tool execution is silent between the SDK's `tool_use` and the matching
    // `tool_result`. While any tool is pending, use the longer toolIdleMs
    // watchdog instead of the generation watchdog so healthy tool runs are not
    // aborted after 90s.
    let pendingTool = false
    try {
      while (!ac.signal.aborted) {
        const nextIdleMs = pendingTool ? toolIdleMs : idleMs
        const next = await this.#nextMessage(iterator, nextIdleMs, ac)
        if (next.done) break
        const msg = next.value
        const sdkId = systemInitSessionId(msg)
        if (sdkId) session.sdkSessionId = sdkId
        if (msg.type === "stream_event") sawPartial = true

        if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type === "tool_use") pendingTool = true
          }
        } else if (msg.type === "user") {
          const content = msg.message.content
          if (
            Array.isArray(content) &&
            content.some((block) => block.type === "tool_result")
          ) {
            pendingTool = false
          }
        }

        for (const update of sdkMessageToUpdates(msg, {
          suppressAssistantText: sawPartial,
        })) {
          await this.#conn.sessionUpdate({ sessionId: session.id, update })
        }
      }
    } finally {
      // Best-effort generator close on any exit (stall, cancel, error). Do NOT
      // await it: on a stall the generator is suspended mid-`await` and its
      // `.return()` never settles, so awaiting here would re-introduce the very
      // hang we guard against. The turn's AbortController — already aborted on
      // a stall or a cancel — is what actually tears the SDK subprocess down.
      void Promise.resolve(iterator.return?.(undefined)).catch(() => undefined)
    }
  }

  /**
   * Await the next SDK message, but no longer than `idleMs`. On timeout the
   * turn is treated as stalled: abort the shared controller (tearing down the
   * SDK subprocess) and reject with {@link TurnStalledError}. `idleMs <= 0`
   * disables the watchdog and awaits indefinitely (legacy behaviour).
   */
  async #nextMessage(
    iterator: AsyncIterator<SDKMessage>,
    idleMs: number,
    ac: AbortController,
  ): Promise<IteratorResult<SDKMessage>> {
    const next = iterator.next()
    if (idleMs <= 0) return next
    // If the watchdog wins the race, `next` settles later with nobody awaiting
    // it; pre-attach a no-op handler so a late rejection isn't "unhandled".
    void next.catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const watchdog = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        ac.abort()
        reject(new TurnStalledError(idleMs))
      }, idleMs)
      // Don't let the watchdog alone keep the event loop alive.
      timer.unref()
    })
    try {
      return await Promise.race([next, watchdog])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
