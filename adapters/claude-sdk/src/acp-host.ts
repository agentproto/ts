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
import { buildQueryOptions, type ClaudeSdkConfig } from "./options.js"

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
      if (ac.signal.aborted) {
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
   *  each SDK message to ACP updates and relay them. */
  async #drive(
    session: SessionState,
    text: string,
    options: Options,
    ac: AbortController,
  ): Promise<void> {
    for await (const msg of this.#query({ prompt: text, options })) {
      if (ac.signal.aborted) break
      const sdkId = systemInitSessionId(msg)
      if (sdkId) session.sdkSessionId = sdkId
      for (const update of sdkMessageToUpdates(msg)) {
        await this.#conn.sessionUpdate({ sessionId: session.id, update })
      }
    }
  }
}
