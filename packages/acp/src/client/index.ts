/**
 * AIP-44 ACP client — drives a subprocess agent via stdio JSON-RPC.
 *
 * Wraps `@agentclientprotocol/sdk`'s `ClientSideConnection`. Owns the
 * connection lifecycle, runs `initialize` on construction, and exposes
 * a session API where each `prompt()` call returns an
 * `AsyncIterable<StreamEvent>` fed by the SDK's `session/update`
 * notification handler.
 */

import {
  ClientSideConnection,
  ndJsonStream,
  type Client as AcpClientHandlers,
  type Stream,
} from "@agentclientprotocol/sdk"
import type { AcpMcpServer, StreamEvent } from "../types.js"

const PROTOCOL_VERSION_DEFAULT = 1

/**
 * Map our internal `AcpMcpServer` (`{ name, transport, ref }`) onto the
 * `@agentclientprotocol/sdk` wire shape expected by
 * `session/new.mcpServers` (and `session/load.mcpServers`).
 *
 * The ACP `McpServer` union is transport-tagged and field-named
 * differently from our compact internal form:
 *   - http → `{ type: "http", name, url, headers: [] }`
 *   - sse  → `{ type: "sse",  name, url, headers: [] }`
 *   - stdio → `{ name, command, args: [], env: [] }` (untagged variant)
 *
 * Without this mapping the raw `{ transport, ref }` entry reaches the
 * agent verbatim and `session/new` rejects with `Invalid params` — the
 * symptom that broke orchestrator spawns (the auto-injected scoped
 * gateway is an `http` entry).
 *
 * Retro-compat: an entry that already carries an ACP-native discriminator
 * (`type`/`url`/`command`) is passed through untouched, so callers that
 * pre-shape their entries keep working.
 */
export function toAcpMcpServers(servers: readonly unknown[]): unknown[] {
  return servers.map(toAcpMcpServer)
}

function toAcpMcpServer(server: unknown): unknown {
  if (!server || typeof server !== "object") return server
  const entry = server as Record<string, unknown>

  // Already ACP-native (has a wire discriminator) → leave as-is.
  if ("type" in entry || "url" in entry || "command" in entry) return entry

  const transport = entry.transport
  // Not our `{ name, transport, ref }` shape → nothing to map.
  if (typeof transport !== "string") return entry

  const { name, ref } = entry as Pick<AcpMcpServer, "name" | "ref"> & {
    transport: string
  }

  switch (transport) {
    case "http":
      return { type: "http", name, url: ref ?? "", headers: [] }
    case "sse":
      return { type: "sse", name, url: ref ?? "", headers: [] }
    case "stdio":
      return { name, command: ref ?? "", args: [], env: [] }
    default:
      return entry
  }
}

export interface AcpClientOptions {
  /** Output bytes go here (subprocess stdin). */
  output: WritableStream<Uint8Array>
  /** Input bytes come from here (subprocess stdout). */
  input: ReadableStream<Uint8Array>
  /** Client identity advertised during `initialize`. */
  clientInfo?: {
    name: string
    title?: string
    version?: string
  }
  /** Client capabilities advertised during `initialize`. */
  capabilities?: {
    fs?: { readTextFile?: boolean; writeTextFile?: boolean }
    terminal?: boolean
  }
  /** Optional handlers for agent-initiated requests beyond fs / terminal. */
  handlers?: Partial<AcpClientHandlers>
  /** Protocol version to negotiate. Defaults to the SDK's current. */
  protocolVersion?: number
  /**
   * Called on ANY JSON-RPC traffic with the child agent process — every
   * incoming `session/update` notification (even ones that
   * `translateSessionUpdate` maps to `null`, e.g. a `tool_call_update`
   * still in progress) and every outbound RPC call this client makes
   * (`newSession`, `loadSession`, `setSessionConfigOption`, `prompt`,
   * `cancel`). Distinct from the `StreamEvent` stream: fires even
   * during gaps where no event is produced, so a host can track
   * liveness independent of what the agent actually says.
   */
  onActivity?: () => void
}

export interface AcpClient {
  readonly connection: ClientSideConnection
  /** Negotiated agent capabilities returned from `initialize`. */
  readonly agentCapabilities: Record<string, unknown> | undefined
  newSession(params: {
    cwd: string
    mcpServers?: unknown[]
    /**
     * Model to select via `session/set_config_option` immediately after
     * `newSession`. The claude-agent-acp wrapper supports this as
     * `configId:"model"`. Omit to keep the agent's own default.
     */
    model?: string
    /**
     * Effort level to select via `session/set_config_option` after
     * `newSession`. Effort is model-dependent — same label ≠ same
     * budget across models; defaults differ too (see AgentCliConnectOptions).
     * Omit to keep the model's own default.
     */
    effort?: string
  }): Promise<AcpClientSession>
  /**
   * Reattach to an existing session by id. Available only when the
   * agent advertised `loadSession: true` in its capabilities (callers
   * should check `agentCapabilities` first; we forward the SDK error
   * verbatim if they don't).
   *
   * Drives the AIP-45 native-resume continuation strategy: the host
   * persists the `sessionId` returned by `newSession`, then on a
   * cold start (process restart, fresh sandbox, different machine)
   * spawns a new subprocess and calls `loadSession` to pick up
   * the conversation from the stored history.
   */
  loadSession(params: {
    sessionId: string
    cwd: string
    mcpServers?: unknown[]
  }): Promise<AcpClientSession>
  close(): Promise<void>
}

export interface AcpClientSession {
  readonly sessionId: string
  prompt(input: {
    messages: unknown[]
    signal?: AbortSignal
  }): AsyncIterable<StreamEvent>
  cancel(): Promise<void>
  close(): Promise<void>
}

interface SessionState {
  events: StreamEvent[]
  resolveNext: ((evt: StreamEvent | undefined) => void) | null
  done: boolean
  active: boolean
}

export async function createAcpClient(
  options: AcpClientOptions,
): Promise<AcpClient> {
  const sessions = new Map<string, SessionState>()

  const stream: Stream = ndJsonStream(options.output, options.input)

  const connection: ClientSideConnection = new ClientSideConnection(
    () => buildClientHandlers(options.handlers ?? {}, sessions, options.onActivity),
    stream,
  )

  const initResponse = await connection.initialize({
    protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION_DEFAULT,
    clientCapabilities: clientCapabilitiesFromOptions(options),
    clientInfo: options.clientInfo
      ? {
          name: options.clientInfo.name,
          title: options.clientInfo.title ?? options.clientInfo.name,
          version: options.clientInfo.version ?? "0.0.0",
        }
      : undefined,
  } as never)

  return {
    connection,
    agentCapabilities: (initResponse as { agentCapabilities?: Record<string, unknown> })
      .agentCapabilities,
    async newSession(params) {
      const response = await connection.newSession({
        cwd: params.cwd,
        mcpServers: toAcpMcpServers(params.mcpServers ?? []) as never,
      } as never)
      options.onActivity?.()
      const sessionId = (response as { sessionId: string }).sessionId
      const state: SessionState = {
        events: [],
        resolveNext: null,
        done: false,
        active: false,
      }
      sessions.set(sessionId, state)
      // Apply model + effort via session/set_config_option immediately
      // after newSession. The claude-agent-acp wrapper handles these as
      // configId:"model" and configId:"effort". Both are optional — when
      // omitted the agent keeps its own defaults (which vary by model).
      // We call these sequentially so a model switch (which rebuilds the
      // effort options) always precedes the effort set.
      if (params.model) {
        await connection.setSessionConfigOption({
          configId: "model",
          value: params.model,
          sessionId,
        } as never)
        options.onActivity?.()
      }
      if (params.effort) {
        try {
          await connection.setSessionConfigOption({
            configId: "effort",
            value: params.effort,
            sessionId,
          } as never)
          options.onActivity?.()
        } catch (err) {
          // Best-effort: this ACP server does not support the "effort" config
          // option (e.g. claude-agent-acp ignores unknown config keys and
          // some versions reject them outright). A rejected set_config_option
          // must never kill the spawn — effort is silently ignored instead.
          console.warn(
            `[acp] set_config_option effort="${params.effort}" rejected by server (best-effort):`,
            err instanceof Error ? err.message : err,
          )
        }
      }
      return buildSession(connection, sessionId, state, sessions, options.onActivity)
    },
    async loadSession(params) {
      // SDK returns `LoadSessionResponse` (no body fields we need); the
      // sessionId is what the caller already provided. We register a
      // fresh `SessionState` so subsequent `prompt` calls have a slot
      // to flush events into — same lifecycle shape as a brand-new
      // session.
      await connection.loadSession({
        sessionId: params.sessionId,
        cwd: params.cwd,
        mcpServers: toAcpMcpServers(params.mcpServers ?? []) as never,
      } as never)
      options.onActivity?.()
      const state: SessionState = {
        events: [],
        resolveNext: null,
        done: false,
        active: false,
      }
      sessions.set(params.sessionId, state)
      return buildSession(connection, params.sessionId, state, sessions, options.onActivity)
    },
    async close() {
      sessions.clear()
    },
  }
}

function clientCapabilitiesFromOptions(
  options: AcpClientOptions,
): Record<string, unknown> {
  const caps = options.capabilities ?? {}
  return {
    fs: {
      readTextFile: caps.fs?.readTextFile ?? false,
      writeTextFile: caps.fs?.writeTextFile ?? false,
    },
    terminal: caps.terminal ?? false,
  }
}

function buildSession(
  connection: ClientSideConnection,
  sessionId: string,
  state: SessionState,
  sessions: Map<string, SessionState>,
  onActivity?: () => void,
): AcpClientSession {
  return {
    sessionId,
    prompt(input) {
      if (state.active) {
        throw new Error(
          `AcpClientSession.prompt: session ${sessionId} already has an in-flight prompt`,
        )
      }
      state.active = true
      state.done = false
      state.events.length = 0

      const iter = makeIterator(state)

      // Outbound send — proves the daemon is still driving this turn,
      // independent of whatever StreamEvents come back.
      onActivity?.()
      const promise = connection
        .prompt({
          sessionId,
          prompt: input.messages as never,
        } as never)
        .then((response) => {
          onActivity?.()
          enqueue(state, {
            kind: "turn-end",
            sessionId,
            reason:
              ((response as { stopReason?: string }).stopReason ===
                "cancelled" && "cancelled") ||
              ((response as { stopReason?: string }).stopReason ===
                "max_turns" && "max_turns") ||
              "completed",
          })
        })
        .catch((err: unknown) => {
          const message =
            err instanceof Error ? err.message : String(err)
          enqueue(state, {
            kind: "error",
            sessionId,
            error: { message },
          })
        })
        .finally(() => {
          state.active = false
          state.done = true
          flush(state)
        })

      if (input.signal) {
        input.signal.addEventListener(
          "abort",
          () => {
            void connection.cancel({ sessionId } as never)
          },
          { once: true },
        )
      }

      void promise
      return iter
    },
    async cancel() {
      if (!state.active) return
      await connection.cancel({ sessionId } as never)
      onActivity?.()
    },
    async close() {
      sessions.delete(sessionId)
    },
  }
}

function makeIterator(state: SessionState): AsyncIterable<StreamEvent> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (state.events.length > 0) {
            const value = state.events.shift() as StreamEvent
            return { value, done: false }
          }
          if (state.done) return { value: undefined, done: true }
          const value = await new Promise<StreamEvent | undefined>(
            (resolve) => {
              state.resolveNext = resolve
            },
          )
          if (value === undefined) return { value: undefined, done: true }
          return { value, done: false }
        },
      }
    },
  }
}

function enqueue(state: SessionState, event: StreamEvent) {
  if (state.resolveNext) {
    const r = state.resolveNext
    state.resolveNext = null
    r(event)
    return
  }
  state.events.push(event)
}

function flush(state: SessionState) {
  if (state.resolveNext) {
    const r = state.resolveNext
    state.resolveNext = null
    r(undefined)
  }
}

function buildClientHandlers(
  partial: Partial<AcpClientHandlers>,
  sessions: Map<string, SessionState>,
  onActivity?: () => void,
): AcpClientHandlers {
  return {
    async sessionUpdate(params) {
      // Every notification is a liveness signal, even ones that don't
      // translate into a StreamEvent below (e.g. an in-progress
      // tool_call_update) — this is the gap that leaves lastOutputAt
      // stale during a long internal tool-call chain.
      onActivity?.()

      const sid = (params as { sessionId?: string }).sessionId
      if (!sid) return
      const state = sessions.get(sid)
      if (!state) return

      const update = (params as { update?: Record<string, unknown> }).update
      if (!update) return
      const event = translateSessionUpdate(sid, update)
      if (event) enqueue(state, event)

      if (partial.sessionUpdate) await partial.sessionUpdate(params)
    },
    async requestPermission(params) {
      if (partial.requestPermission) return partial.requestPermission(params)
      throw new Error("AcpClient.requestPermission: no handler configured")
    },
    async readTextFile(params) {
      if (partial.readTextFile) return partial.readTextFile(params)
      throw new Error("AcpClient.readTextFile: capability not advertised")
    },
    async writeTextFile(params) {
      if (partial.writeTextFile) return partial.writeTextFile(params)
      throw new Error("AcpClient.writeTextFile: capability not advertised")
    },
    ...(partial as object),
  } as AcpClientHandlers
}

function translateSessionUpdate(
  sessionId: string,
  update: Record<string, unknown>,
): StreamEvent | null {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return {
        kind: "text-delta",
        sessionId,
        text: extractText(update.content),
      }
    case "agent_thought_chunk":
      return {
        kind: "thought",
        sessionId,
        text: extractText(update.content),
      }
    case "tool_call": {
      const toolCallId = (update.toolCallId as string) ?? ""
      return {
        kind: "tool-call",
        sessionId,
        toolCallId,
        toolName: (update.kind as string) ?? (update.title as string) ?? "tool",
        arguments: update.rawInput ?? update.content ?? {},
      }
    }
    case "tool_call_update": {
      const status = update.status as string | undefined
      if (status === "completed" || status === "failed") {
        return {
          kind: "tool-result",
          sessionId,
          toolCallId: (update.toolCallId as string) ?? "",
          result: update.rawOutput ?? update.content ?? null,
          isError: status === "failed",
        }
      }
      return null
    }
    case "user_message_chunk":
      return null
    default:
      return null
  }
}

function extractText(content: unknown): string {
  if (!content) return ""
  if (typeof content === "string") return content
  if (typeof content === "object" && content !== null) {
    const c = content as { type?: string; text?: string }
    if (c.type === "text" && typeof c.text === "string") return c.text
  }
  return ""
}
