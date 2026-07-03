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
  /**
   * Turn-idle watchdog: if a `prompt()` call goes this many ms with NO
   * activity signal (see `onActivity` above — incoming `session/update`
   * notifications, outbound RPCs) and the underlying `connection.prompt()`
   * promise still hasn't resolved, synthesize a `turn-end` event with
   * `reason: "watchdog-timeout"` so the caller's async iterator completes
   * instead of hanging forever. The timer resets on every activity signal
   * observed DURING that turn, so a legitimately long tool-call chain
   * (still producing activity, just no user-visible output) never
   * false-positives — this is "N ms of true silence," not "N ms since the
   * turn started."
   *
   * Undefined (the default) disables the watchdog entirely — existing
   * callers see no behavior change. If the real `connection.prompt()`
   * eventually settles after the synthetic turn-end was already emitted,
   * the late result is logged and discarded (no crash, no duplicate
   * turn-end for the same logical turn).
   */
  turnIdleTimeoutMs?: number
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
  /**
   * Set by `buildSession.prompt()` for the duration of an in-flight turn
   * when a watchdog timer is armed; cleared once that turn settles. Lets
   * the `sessionUpdate` handler (which only has a `sessionId`, not a
   * closure over the turn's timer) bump the SAME timer an incoming
   * notification is liveness evidence for.
   */
  resetWatchdogTimer?: () => void
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
      return buildSession(
        connection,
        sessionId,
        state,
        sessions,
        options.onActivity,
        options.turnIdleTimeoutMs,
      )
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
      return buildSession(
        connection,
        params.sessionId,
        state,
        sessions,
        options.onActivity,
        options.turnIdleTimeoutMs,
      )
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
  turnIdleTimeoutMs?: number,
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

      // Turn-idle watchdog — undefined turnIdleTimeoutMs disables it
      // entirely (existing callers see no behavior change). Armed below
      // and re-armed on every activity signal observed during this turn
      // (outbound send, resolve, and incoming session/update via
      // `state.resetWatchdogTimer`); cleared once the turn settles.
      let watchdogTimer: ReturnType<typeof setTimeout> | undefined
      let watchdogFired = false
      const clearWatchdogTimer = () => {
        if (watchdogTimer) clearTimeout(watchdogTimer)
        watchdogTimer = undefined
      }
      const armWatchdogTimer = () => {
        if (turnIdleTimeoutMs === undefined) return
        clearWatchdogTimer()
        watchdogTimer = setTimeout(() => {
          watchdogFired = true
          state.done = true
          enqueue(state, { kind: "turn-end", sessionId, reason: "watchdog-timeout" })
        }, turnIdleTimeoutMs)
      }
      state.resetWatchdogTimer = armWatchdogTimer

      // Outbound send — proves the daemon is still driving this turn,
      // independent of whatever StreamEvents come back. Also the initial
      // arm of the watchdog timer, so the timeout is measured from "we
      // just sent this" rather than some earlier idle point.
      armWatchdogTimer()
      onActivity?.()
      const promise = connection
        .prompt({
          sessionId,
          prompt: input.messages as never,
        } as never)
        .then((response) => {
          clearWatchdogTimer()
          onActivity?.()
          if (watchdogFired) {
            console.warn(
              `[acp] session ${sessionId}: connection.prompt() resolved after the ` +
                `turn-idle watchdog already synthesized a turn-end — ignoring late response.`,
            )
            return
          }
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
          clearWatchdogTimer()
          if (watchdogFired) {
            console.warn(
              `[acp] session ${sessionId}: connection.prompt() rejected after the ` +
                `turn-idle watchdog already synthesized a turn-end — ignoring late error:`,
              err instanceof Error ? err.message : err,
            )
            return
          }
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
          state.resetWatchdogTimer = undefined
          clearWatchdogTimer()
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

      // Reset this session's in-flight turn watchdog (if any) — an
      // incoming notification is exactly the "not silent" signal the
      // watchdog exists to detect the absence of.
      state.resetWatchdogTimer?.()

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
      // `title` is the descriptive label an agent gives a tool call
      // ("Reading src/foo.ts") — prefer it over the coarse `kind`
      // bucket (read/edit/search/execute/…) so rendered lines are
      // informative instead of generic.
      const toolName =
        (update.title as string) ?? (update.kind as string) ?? "tool"
      const locations = update.locations as
        | Array<{ path: string; line?: number | null }>
        | undefined
      let args: unknown = update.rawInput ?? update.content ?? {}
      // Some tool calls (e.g. a bare "read" with no structured input)
      // carry only `locations` — fold the file paths into `arguments`
      // so they survive downstream instead of being dropped.
      if (update.rawInput == null && locations && locations.length > 0) {
        args =
          locations.length === 1
            ? {
                path: locations[0]!.path,
                ...(locations[0]!.line != null
                  ? { line: locations[0]!.line }
                  : {}),
              }
            : { paths: locations.map((location) => location.path) }
      }
      return {
        kind: "tool-call",
        sessionId,
        toolCallId,
        toolName,
        arguments: args,
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
    case "plan": {
      const entries = (update.entries as Array<Record<string, unknown>>) ?? []
      return {
        kind: "plan",
        sessionId,
        entries: entries.map((entry) => ({
          content: (entry.content as string) ?? "",
          priority: (entry.priority as "high" | "medium" | "low") ?? "medium",
          status:
            (entry.status as "pending" | "in_progress" | "completed") ??
            "pending",
        })),
      }
    }
    case "usage_update": {
      const cost = update.cost as { amount: number; currency: string } | null | undefined
      // Accept both camelCase and snake_case token fields — agents differ on
      // the convention and this update kind is non-standard ACP.
      const numeric = (...keys: string[]): number | undefined => {
        for (const key of keys) {
          const v = update[key]
          if (typeof v === "number") return v
        }
        return undefined
      }
      const tokensIn = numeric("tokensIn", "input_tokens", "inputTokens")
      const tokensOut = numeric("tokensOut", "output_tokens", "outputTokens")
      return {
        kind: "usage_update",
        sessionId,
        size: (update.size as number) ?? 0,
        used: (update.used as number) ?? 0,
        ...(cost ? { cost } : {}),
        ...(tokensIn !== undefined ? { tokensIn } : {}),
        ...(tokensOut !== undefined ? { tokensOut } : {}),
      }
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
