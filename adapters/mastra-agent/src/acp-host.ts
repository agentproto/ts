/**
 * WP2 — the agent side of AIP-44 ACP, backed by a Mastra `AgentController`.
 *
 * Implements the `@agentclientprotocol/sdk` `Agent` interface: handles the
 * session lifecycle and, on `session/prompt`, drives a controller `Session`'s
 * `sendMessage()` — relaying its subscription events as ACP `session/update`s
 * (text deltas as `agent_message_chunk`, tool activity as `tool_call` /
 * `tool_call_update`), exactly as an IDE/host expects from codex or
 * claude-code.
 *
 * No Mastra-specific protocol knowledge leaks past this file; everything above
 * is the standard ACP wire, so the daemon spawns this like any other arm.
 */

import type {
  AgentSideConnection,
  Agent as AcpAgent,
  AuthenticateRequest,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
} from "@agentclientprotocol/sdk"
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import type { AgentControllerEvent } from "@mastra/core/agent-controller"
import { createEventMapper } from "./tool-call-map.js"

/** The slice of a controller `Session` this host drives. Typed structurally so
 *  tests can script one and we don't couple to a specific @mastra/core
 *  version's `Session` generics. */
export interface ControllerSessionLike {
  subscribe(
    listener: (event: AgentControllerEvent) => void | Promise<void>,
  ): () => void
  sendMessage(input: { content: string }): Promise<void>
  abort(): void
}

/** The slice of an `AgentController` this host drives (structural, as above).
 *  `createSession` keys on (resourceId, scope) — one ACP session maps to one
 *  controller session via a unique scope, with the thread pinned to the ACP
 *  session id so memory recall is scoped exactly as before. */
export interface ControllerLike {
  init(): Promise<void>
  createSession(opts: {
    resourceId?: string
    scope?: string
    threadId?: string
  }): Promise<ControllerSessionLike>
}

/** Lazily builds the controller (so model/key/AGENT.md errors surface on the
 *  first prompt with a clear message, not at process spawn or session/new). */
export type ControllerFactory = () => Promise<{ controller: ControllerLike }>

interface SessionState {
  /** The controller session, created lazily on the first prompt. */
  session: ControllerSessionLike | null
  /** The in-flight prompt turn, if any. Turn-scoped (not session-scoped) so a
   *  superseding prompt cancelling this one can't clobber its own state. */
  turn: { cancelled: boolean } | null
}

/** Pull the user's text out of an ACP prompt (its `text` content blocks). */
export function promptText(params: PromptRequest): string {
  const blocks = Array.isArray(params.prompt) ? params.prompt : []
  return blocks
    .filter((b): b is { type: "text"; text: string } =>
      Boolean(b) && (b as { type?: string }).type === "text" &&
      typeof (b as { text?: unknown }).text === "string",
    )
    .map((b) => b.text)
    .join("")
    .trim()
}

export class MastraAcpAgent implements AcpAgent {
  readonly #conn: AgentSideConnection
  readonly #buildController: ControllerFactory
  readonly #resource: string
  readonly #sessions = new Map<string, SessionState>()
  #controller: ControllerLike | null = null

  constructor(
    conn: AgentSideConnection,
    buildController: ControllerFactory,
    resource = "mastra-agent",
  ) {
    this.#conn = conn
    this.#buildController = buildController
    // `resource` groups a user's threads in Mastra memory; one per agent here.
    this.#resource = resource
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        // Stateless per-prompt for now; no resume/replay surface.
        loadSession: false,
      },
    }
  }

  async authenticate(
    _params: AuthenticateRequest,
  ): Promise<Record<string, never>> {
    // The provider key is read from the spawn env by the model gateway — no
    // ACP-level auth handshake needed.
    return {}
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = randomId()
    this.#sessions.set(sessionId, { session: null, turn: null })
    return { sessionId }
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const state = this.#sessions.get(params.sessionId)
    if (!state) throw new Error(`unknown session ${params.sessionId}`)

    // Cancel any in-flight turn for this session before starting a new one.
    if (state.turn) {
      state.turn.cancelled = true
      state.session?.abort()
    }
    const turn = { cancelled: false }
    state.turn = turn

    const text = promptText(params)
    try {
      const session = await this.#ensureSession(params.sessionId, state)

      // One mapper per turn: it holds the per-message "text already relayed"
      // state that turns Mastra's full-message updates into ACP deltas.
      const map = createEventMapper()
      let endReason: string | undefined
      let lastError: Error | null = null
      // Updates must hit the wire in event order; the listener is synchronous
      // while sessionUpdate is not, so sends are chained.
      let relay: Promise<void> = Promise.resolve()

      const unsubscribe = session.subscribe((event) => {
        if (event.type === "error") {
          lastError = event.error
          return
        }
        if (event.type === "agent_end") {
          endReason = event.reason ?? "complete"
          return
        }
        const update = map(event)
        if (!update) return
        relay = relay.then(() =>
          this.#conn.sessionUpdate({ sessionId: params.sessionId, update }),
        )
      })
      try {
        // Awaits the whole run; events stream via the subscription above.
        await session.sendMessage({ content: text })
      } finally {
        unsubscribe()
        // Flush queued updates; a dead connection shouldn't mask the turn's
        // real outcome (and there is nowhere left to report it anyway).
        await relay.catch(() => {})
      }

      if (turn.cancelled || endReason === "aborted") {
        return { stopReason: "cancelled" }
      }
      if (endReason === "error") {
        // `sendMessage` resolves even when the run dies (the engine reports
        // via `error` events + agent_end reason) — re-throw into the shared
        // error path so the failure surfaces exactly as before.
        throw lastError ?? new Error("the agent run ended with an error")
      }
      return { stopReason: "end_turn" }
    } catch (err) {
      if (turn.cancelled) return { stopReason: "cancelled" }
      // Surface the failure to the client as a message chunk, then end the
      // turn — better UX than a bare JSON-RPC error the host may swallow.
      await this.#conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `\n[mastra-agent error] ${(err as Error).message}\n`,
          },
        },
      })
      return { stopReason: "refusal" }
    } finally {
      if (state.turn === turn) state.turn = null
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const state = this.#sessions.get(params.sessionId)
    if (!state) return
    if (state.turn) state.turn.cancelled = true
    state.session?.abort()
  }

  /**
   * The host applies the `model` (and other operator options) as a `--model`
   * spawn arg via the manifest `bin_args_template`, then ALSO calls this ACP
   * config hook (the daemon's default "config" apply path). The model is
   * already in effect, so this is a no-op that just reports our (empty) set of
   * runtime-configurable options. Without it the spawn fails with
   * "Method not found: session/set_config_option".
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

  /** Resolve this ACP session's controller session, creating it on first use.
   *  Deferred to the first prompt (not session/new) on purpose: controller
   *  construction parses the AGENT.md and resolves the model, and those
   *  errors must keep surfacing as a first-prompt error chunk + "refusal",
   *  never as a session/new JSON-RPC failure. */
  async #ensureSession(
    acpSessionId: string,
    state: SessionState,
  ): Promise<ControllerSessionLike> {
    if (state.session) return state.session
    const controller = await this.#ensureController()
    // Thread = ACP session id, resource = the shared agent resource — the same
    // memory layout the raw-stream host used, so recall stays scoped to this
    // session's history. `scope` keeps concurrent ACP sessions on distinct
    // controller sessions despite the shared resourceId.
    const session = await controller.createSession({
      resourceId: this.#resource,
      scope: acpSessionId,
      threadId: acpSessionId,
    })
    state.session = session
    return session
  }

  async #ensureController(): Promise<ControllerLike> {
    // Memoize only on success so a transient failure retries on the next
    // prompt instead of pinning every future turn to the first error.
    if (this.#controller) return this.#controller
    const { controller } = await this.#buildController()
    await controller.init()
    this.#controller = controller
    return controller
  }
}

/** 16 random bytes as hex — matches the SDK example's session id shape. */
function randomId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}
