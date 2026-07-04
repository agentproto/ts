/**
 * WP2 — the agent side of AIP-44 ACP, backed by a live Mastra agent.
 *
 * Implements the `@agentclientprotocol/sdk` `Agent` interface: handles the
 * session lifecycle and, on `session/prompt`, drives a Mastra agent's
 * `stream()` — relaying each text delta as an `agent_message_chunk`
 * `session/update`, exactly as an IDE/host expects from codex or claude-code.
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
import { type MastraStreamChunk, chunkToSessionUpdate } from "./tool-call-map.js"

/** A built Mastra agent — only the surface we need (its `stream`). Typed
 *  structurally so we don't couple to a specific @mastra/core version.
 *
 *  We read `fullStream` (the typed chunk union: text deltas AND tool-call /
 *  tool-result events) so tool activity surfaces as ACP `tool_call` updates,
 *  not only the final prose. `textStream` is kept as an optional fallback for
 *  a stripped agent that exposes only text. */
export interface MastraLike {
  stream(
    input: string,
    options?: {
      abortSignal?: AbortSignal
      /** Memory threading — `thread` scopes recall to one ACP session. */
      memory?: { thread?: string; resource?: string }
      /** Max agentic loop steps (tool-call → execute → continue). Default 1 = no loop. */
      maxSteps?: number
    },
  ): Promise<{
    fullStream?: ReadableStream<unknown>
    textStream?: ReadableStream<string>
    text?: Promise<string>
  }>
}

/** Lazily builds the Mastra agent (so model/key errors surface on the first
 *  prompt with a clear message, not at process spawn). */
export type AgentFactory = () => Promise<MastraLike>

interface SessionState {
  prompt: AbortController | null
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
  readonly #buildAgent: AgentFactory
  readonly #resource: string
  readonly #sessions = new Map<string, SessionState>()
  #agent: MastraLike | null = null

  constructor(
    conn: AgentSideConnection,
    buildAgent: AgentFactory,
    resource = "mastra-agent",
  ) {
    this.#conn = conn
    this.#buildAgent = buildAgent
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
    this.#sessions.set(sessionId, { prompt: null })
    return { sessionId }
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
      const agent = await this.#ensureAgent()
      // Thread = ACP session id → recall is scoped to this session's history.
      const result = await agent.stream(text, {
        abortSignal: ac.signal,
        memory: { thread: params.sessionId, resource: this.#resource },
        maxSteps: 200,
      })
      if (result.fullStream) {
        // Preferred path: the typed chunk stream carries text deltas AND
        // tool-call / tool-result events, so tool activity surfaces live.
        await this.#pumpFullStream(params.sessionId, result.fullStream, ac)
      } else if (result.textStream) {
        // Fallback: a text-only agent — relay prose deltas, no tool surface.
        await this.#pumpTextStream(params.sessionId, result.textStream, ac)
      }
    } catch (err) {
      if (ac.signal.aborted) return { stopReason: "cancelled" }
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

  /** Drain Mastra's typed `fullStream`, mapping each chunk to an ACP
   *  `session/update` (text deltas + tool_call / tool_call_update). */
  async #pumpFullStream(
    sessionId: string,
    stream: ReadableStream<unknown>,
    ac: AbortController,
  ): Promise<void> {
    const reader = stream.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done || ac.signal.aborted) break
        if (!value) continue
        // Single boundary cast: raw Mastra chunks include many event types
        // beyond what MastraStreamChunk models; chunkToSessionUpdate returns
        // null for anything it doesn't recognise.
        const update = chunkToSessionUpdate(value as MastraStreamChunk)
        if (update) await this.#conn.sessionUpdate({ sessionId, update })
      }
    } finally {
      reader.releaseLock()
    }
  }

  /** Fallback drain for an agent exposing only a plain text stream. */
  async #pumpTextStream(
    sessionId: string,
    stream: ReadableStream<string>,
    ac: AbortController,
  ): Promise<void> {
    const reader = stream.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done || ac.signal.aborted) break
        if (value) {
          await this.#conn.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: value },
            },
          })
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  async #ensureAgent(): Promise<MastraLike> {
    if (!this.#agent) this.#agent = await this.#buildAgent()
    return this.#agent
  }
}

/** 16 random bytes as hex — matches the SDK example's session id shape. */
function randomId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}
