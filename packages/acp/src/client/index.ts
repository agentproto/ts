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
import type {
  AcpMcpServer,
  AcpPermissionResolution,
  StreamEvent,
} from "../types.js"

export type { AcpPermissionResolution }

const PROTOCOL_VERSION_DEFAULT = 1

/**
 * The doubly-nested `RequestPermissionResponse` shape the ACP SDK expects
 * back from a `session/request_permission` handler — see
 * `@agentproto/driver-agent-cli`'s `AcpPermissionOutcome` for the full
 * rationale on why the `outcome` field is nested.
 */
type RequestPermissionResponse =
  | { outcome: { outcome: "selected"; optionId: string } }
  | { outcome: { outcome: "cancelled" } }

/** A `session/request_permission` RPC parked by permission-hold mode. */
interface HeldPermission {
  sessionId: string
  resolve: (response: RequestPermissionResponse) => void
}

/**
 * Map our internal `AcpMcpServer` (`{ name, transport, ref, headers, credentialRef }`)
 * onto the `@agentclientprotocol/sdk` wire shape expected by
 * `session/new.mcpServers` (and `session/load.mcpServers`).
 *
 * The ACP `McpServer` union is transport-tagged and field-named
 * differently from our compact internal form:
 *   - http → `{ type: "http", name, url, headers: [{ name, value }, …] }`
 *   - sse  → `{ type: "sse",  name, url, headers: [{ name, value }, …] }`
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

  const name = entry.name
  const ref = entry.ref
  const headers = entry.headers

  switch (transport) {
    case "http":
      return { type: "http", name, url: ref ?? "", headers: toAcpHeaders(headers) }
    case "sse":
      return { type: "sse", name, url: ref ?? "", headers: toAcpHeaders(headers) }
    case "stdio":
      return { name, command: ref ?? "", args: [], env: [] }
    default:
      return entry
  }
}

function toAcpHeaders(headers: unknown): Array<{ name: string; value: string }> {
  if (!headers || typeof headers !== "object") return []
  return Object.entries(headers).map(([name, value]) => ({
    name,
    value: typeof value === "string" ? value : String(value),
  }))
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
  /**
   * When true, every `session/request_permission` the agent raises is
   * SURFACED (emitted as an `agent-prompt` StreamEvent on the session's
   * stream) and HELD — the RPC does not resolve until the host calls
   * `respondPermission(requestId, ...)`. `handlers.requestPermission` is
   * bypassed while this is set. Undefined/false (the default) is unchanged:
   * requests go straight to `handlers.requestPermission`. Used by the
   * daemon's cross-session permission inbox.
   */
  permissionHold?: boolean
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
     *
     * Best-effort: a value the agent can't resolve (a stale/gated/typo'd id)
     * is warned about and dropped — the session still starts on the agent's
     * default model rather than crashing the spawn. See the reject handler
     * in `newSession` for the reasoning (agentproto#186).
     */
    model?: string
    /**
     * Effort level to select via `session/set_config_option` after
     * `newSession`. Effort is model-dependent — same label ≠ same
     * budget across models; defaults differ too (see AgentCliConnectOptions).
     * Omit to keep the model's own default.
     */
    effort?: string
    /**
     * Mode to select via `session/set_config_option` after `newSession`,
     * for ACP servers that model mode selection as a session config
     * option (`configId:"mode"`) instead of a CLI flag — e.g. opencode.
     * Best-effort, same as `model`/`effort`: a rejection is warned about
     * and dropped rather than failing the spawn. Omit to keep the
     * agent's own default mode.
     */
    mode?: string
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
  /**
   * Resolve a permission request parked by permission-hold mode. `requestId`
   * is the `toolCallId` carried on the `agent-prompt` StreamEvent that
   * surfaced the request. Returns true when a matching parked request was
   * found and resolved, false when the id is unknown or already resolved
   * (idempotent — a duplicate response is a no-op). No-op returning false
   * when `permissionHold` was never enabled.
   */
  respondPermission(
    requestId: string,
    resolution: AcpPermissionResolution,
  ): boolean
  close(): Promise<void>
}

/**
 * Result of a mid-session `setConfigOption` call — mirrors the best-effort
 * contract `newSession`'s own `model`/`effort`/`mode` params already use
 * (see the reject handler below): a rejected config option is reported
 * structurally, never thrown, so a caller can surface "didn't apply" to a
 * human without the live session (or its in-flight turn) ever being at risk.
 */
export interface SetConfigOptionResult {
  applied: boolean
  /** Present only when `applied` is false — the server's rejection detail
   *  (see `configOptionErrorDetail`), or a client-side reason. */
  reason?: string
}

export interface AcpClientSession {
  readonly sessionId: string
  prompt(input: {
    messages: unknown[]
    signal?: AbortSignal
  }): AsyncIterable<StreamEvent>
  cancel(): Promise<void>
  /**
   * Apply a session config option (e.g. `configId:"model"`) on this LIVE,
   * already-connected session — the mid-session counterpart to the
   * `model`/`effort`/`mode` params `newSession` accepts at connect time.
   * Same non-fatal contract: a server rejection resolves
   * `{applied:false, reason}` instead of throwing, so a bad or gated model
   * id can never kill an otherwise-healthy session.
   */
  setConfigOption(configId: string, value: string): Promise<SetConfigOptionResult>
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

  // Permission-hold state: parked `session/request_permission` RPCs keyed by
  // the stable request id we mint per request (and emit on the `agent-prompt`
  // StreamEvent). Empty and untouched unless `permissionHold` is set.
  const pendingPermissions = new Map<string, HeldPermission>()
  let permissionSeq = 0

  const respondPermission = (
    requestId: string,
    resolution: AcpPermissionResolution,
  ): boolean => {
    const held = pendingPermissions.get(requestId)
    if (!held) return false
    pendingPermissions.delete(requestId)
    held.resolve(
      "cancelled" in resolution
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "selected", optionId: resolution.optionId } },
    )
    return true
  }

  // Resolve every request parked for a session as `cancelled` — used when a
  // session (or the whole client) tears down so no held RPC dangles.
  const cancelPermissionsForSession = (sessionId: string): void => {
    // Collect the matching keys first, THEN delete + resolve — never mutate the
    // map while iterating its entries.
    const ids: string[] = []
    for (const [id, held] of pendingPermissions) {
      if (held.sessionId === sessionId) ids.push(id)
    }
    for (const id of ids) {
      const held = pendingPermissions.get(id)
      if (!held) continue
      pendingPermissions.delete(id)
      held.resolve({ outcome: { outcome: "cancelled" } })
    }
  }

  const stream: Stream = ndJsonStream(options.output, options.input)

  const connection: ClientSideConnection = new ClientSideConnection(
    () =>
      buildClientHandlers(options.handlers ?? {}, sessions, options.onActivity, {
        permissionHold: options.permissionHold ?? false,
        pendingPermissions,
        nextRequestId: () => `perm_${++permissionSeq}`,
      }),
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
        try {
          await connection.setSessionConfigOption({
            configId: "model",
            value: params.model,
            sessionId,
          } as never)
          options.onActivity?.()
        } catch (err) {
          // Non-fatal by design. claude-agent-acp validates the requested
          // model against the concrete option ids it advertises for THIS
          // session (e.g. "default", "opus[1m]", "sonnet", "claude-sonnet-5",
          // "haiku") and rejects anything it can't resolve — including stale
          // or gated ids like "claude-sonnet-4-6" — with a JSON-RPC -32603
          // whose only useful text is buried in `error.data.details`
          // ("Invalid value for config option model: <id>"). Letting that
          // reject `newSession` turned a bad model id into an opaque
          // "spawn failed — Internal error" that killed the whole session
          // (agentproto#186). The accepted vocabulary is dynamic (it varies
          // by wrapper version and account entitlements), so there is no
          // version-stable way to know it before the call — a rejected model
          // must therefore never be fatal. This is NOT a silent drop: the
          // requested id AND the server's own reason are logged, and the
          // session continues on the agent's default model.
          console.warn(
            `[acp] set_config_option model="${params.model}" rejected by server ` +
              `— keeping the agent's default model. Reason: ${configOptionErrorDetail(err)}`,
          )
        }
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
            `[acp] set_config_option effort="${params.effort}" rejected by server ` +
              `(best-effort): ${configOptionErrorDetail(err)}`,
          )
        }
      }
      if (params.mode) {
        try {
          await connection.setSessionConfigOption({
            configId: "mode",
            value: params.mode,
            sessionId,
          } as never)
          options.onActivity?.()
        } catch (err) {
          // Best-effort: this ACP server does not support the "mode" config
          // option, or doesn't recognize the requested mode id. A rejected
          // set_config_option must never kill the spawn — mode is silently
          // ignored (the session keeps whatever mode the agent defaults to).
          console.warn(
            `[acp] set_config_option mode="${params.mode}" rejected by server ` +
              `(best-effort): ${configOptionErrorDetail(err)}`,
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
        cancelPermissionsForSession,
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
        cancelPermissionsForSession,
      )
    },
    respondPermission,
    async close() {
      // Never leave a held permission RPC dangling — resolve all as cancelled.
      for (const [, held] of pendingPermissions) {
        held.resolve({ outcome: { outcome: "cancelled" } })
      }
      pendingPermissions.clear()
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
  onActivity: (() => void) | undefined,
  turnIdleTimeoutMs: number | undefined,
  cancelPermissionsForSession: (sessionId: string) => void,
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
    async setConfigOption(configId, value) {
      try {
        await connection.setSessionConfigOption({
          configId,
          value,
          sessionId,
        } as never)
        onActivity?.()
        return { applied: true }
      } catch (err) {
        // Non-fatal by design — same reasoning as newSession's own
        // model/effort/mode application above: the agent's accepted
        // vocabulary for a config option is dynamic (varies by wrapper
        // version + account entitlements), so a rejection here is
        // expected and must never propagate as a thrown error. The
        // caller decides what to do with `{applied:false, reason}`
        // (e.g. surface a non-modal warning), the session itself is
        // completely unaffected.
        const reason = configOptionErrorDetail(err)
        console.warn(
          `[acp] session ${sessionId}: set_config_option ${configId}="${value}" ` +
            `rejected by server — ${reason}`,
        )
        return { applied: false, reason }
      }
    },
    async close() {
      // Cancel any permission requests this session parked before dropping it,
      // so the agent's held RPCs settle rather than hang.
      cancelPermissionsForSession(sessionId)
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

interface PermissionHoldContext {
  permissionHold: boolean
  pendingPermissions: Map<string, HeldPermission>
  nextRequestId: () => string
}

/**
 * Shape of an ACP `session/request_permission` params object — only the
 * fields we read. Narrowed defensively (all optional) since it arrives as
 * `unknown` from the SDK handler boundary.
 */
interface RequestPermissionParams {
  sessionId?: string
  toolCall?: {
    toolCallId?: string
    title?: string
    kind?: string
  }
  options?: Array<{ optionId?: string; name?: string; kind?: string }>
}

/**
 * Permission-hold path: surface the request as an `agent-prompt` StreamEvent
 * on the owning session's stream and park the RPC in `pendingPermissions`,
 * returning a promise that resolves only when the host calls
 * `respondPermission` (or the session/client tears down). The `agent-prompt`
 * event carries the minted request id as `toolCallId` so the host has the
 * exact key to respond with.
 */
function holdPermissionRequest(
  rawParams: unknown,
  sessions: Map<string, SessionState>,
  ctx: PermissionHoldContext,
): Promise<RequestPermissionResponse> {
  const params = (rawParams ?? {}) as RequestPermissionParams
  const sessionId = params.sessionId ?? ""
  const requestId = ctx.nextRequestId()
  const options = Array.isArray(params.options)
    ? params.options
        .filter((o): o is { optionId: string; name?: string; kind?: string } =>
          typeof o?.optionId === "string",
        )
        .map(o => ({
          optionId: o.optionId,
          ...(typeof o.name === "string" ? { name: o.name } : {}),
          ...(typeof o.kind === "string" ? { kind: o.kind } : {}),
        }))
    : []
  const toolName = params.toolCall?.title ?? params.toolCall?.kind
  const text = toolName
    ? `Allow "${toolName}"?`
    : "The agent is requesting permission to run a tool."

  const state = sessions.get(sessionId)
  if (state) {
    enqueue(state, {
      kind: "agent-prompt",
      sessionId,
      toolCallId: requestId,
      options,
      text,
      ...(toolName ? { toolName } : {}),
    })
  } else {
    // No session slot for this id — the agent-prompt event can't be surfaced,
    // so the host won't see the request in its stream. We still park the RPC
    // below (so the agent doesn't hang), but log it: a missing state here means
    // the request arrived for an unknown/torn-down session and would otherwise
    // vanish silently.
    console.warn(
      `[acp] permission-hold: no session state for sessionId="${sessionId}" ` +
        `(request ${requestId}) — parking the RPC but not surfacing an agent-prompt event.`,
    )
  }

  return new Promise<RequestPermissionResponse>(resolve => {
    ctx.pendingPermissions.set(requestId, { sessionId, resolve })
  })
}

function buildClientHandlers(
  partial: Partial<AcpClientHandlers>,
  sessions: Map<string, SessionState>,
  onActivity: (() => void) | undefined,
  hold: PermissionHoldContext,
): AcpClientHandlers {
  return {
    // Spread the caller-supplied handlers FIRST so the named methods defined
    // below always win. This matters for `requestPermission`: the arm always
    // passes a `requestPermission` handler, and if that spread came last it
    // would clobber the permission-hold guard below — silently bypassing hold
    // mode. With the spread first, our guard stays in control and still falls
    // through to `partial.requestPermission` when hold mode is OFF.
    ...(partial as object),
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
      // Every incoming request is a liveness signal.
      onActivity?.()
      // Permission-hold mode intercepts BEFORE any auto-answer handler: the
      // request is surfaced + parked instead of resolved in-arm.
      if (hold.permissionHold) {
        return holdPermissionRequest(params, sessions, hold) as never
      }
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
  } as AcpClientHandlers
}

/**
 * Nothing worth calling a tool's input: absent, `{}`, or `[]`. All three are
 * what an agent sends when it hasn't decided the input yet — the claude-code
 * bridge announces a read with `rawInput: {}` and `content: []` before it
 * knows the path.
 */
function isEmptyish(value: unknown): boolean {
  if (value == null) return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === "object") return Object.keys(value as object).length === 0
  return false
}

/**
 * Derive a tool call's `arguments` from an ACP tool_call / tool_call_update
 * payload, or undefined when the payload says nothing about the input.
 *
 * Preference order: `rawInput` (the real thing) → the file paths in
 * `locations` (some agents describe a read only that way) → `content`. An
 * EMPTY `rawInput` counts as "nothing", not as "the input is {}" — otherwise
 * the placeholder the agent sends before it knows the input would outrank the
 * locations it did send, and would later look indistinguishable from a real
 * no-argument call.
 */
function toolCallArguments(update: Record<string, unknown>): unknown | undefined {
  const rawInput = update.rawInput
  if (!isEmptyish(rawInput)) return rawInput

  const locations = update.locations as
    | Array<{ path: string; line?: number | null }>
    | undefined
  // Some tool calls (e.g. a bare "read" with no structured input) carry only
  // `locations` — fold the file paths into `arguments` so they survive
  // downstream instead of being dropped. Reached whenever rawInput said
  // nothing, including the `{}` placeholder: a real path beats a placeholder.
  if (locations && locations.length > 0) {
    const first = locations[0]!
    return locations.length === 1
      ? { path: first.path, ...(first.line != null ? { line: first.line } : {}) }
      : { paths: locations.map(location => location.path) }
  }

  if (!isEmptyish(update.content)) return update.content
  // Distinguish "the agent sent an empty input" from "the agent said nothing
  // about the input". The announcement keeps rendering the former as-is; an
  // enrichment carrying the latter isn't worth emitting at all.
  return rawInput != null ? rawInput : undefined
}

/**
 * Build the tool-call ENRICHMENT for a non-terminal `tool_call_update` — the
 * frame where the claude-code bridge delivers the input and the real title
 * for a call it already announced as a bare "Read File" with `rawInput: {}`.
 *
 * Returns null when the update adds nothing (e.g. a bare `{_meta, toolCallId}`
 * keep-alive), so a no-op frame stays a no-op event.
 */
function toolCallEnrichment(
  sessionId: string,
  update: Record<string, unknown>,
): StreamEvent | null {
  const toolCallId = update.toolCallId as string | undefined
  if (!toolCallId) return null
  const args = toolCallArguments(update)
  const title = typeof update.title === "string" ? update.title : undefined
  if (args === undefined && title === undefined) return null
  return {
    kind: "tool-call",
    sessionId,
    toolCallId,
    // "" when the update carried no title — consumers merge only non-empty
    // names, so an untitled enrichment can't erase the announced one.
    toolName: title ?? "",
    arguments: args,
    isUpdate: true,
  }
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
      return {
        kind: "tool-call",
        sessionId,
        toolCallId,
        toolName,
        arguments: toolCallArguments(update) ?? {},
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
      // A non-terminal update is where several agents actually DELIVER the
      // call's input. Captured off the wire from the claude-code bridge:
      //
      //   tool_call        title="Read File"  rawInput={}   locations=[]
      //   tool_call_update title="Read /tmp/probe.txt"
      //                    rawInput={"file_path":"/tmp/probe.txt"}
      //                    locations=[{path:"/tmp/probe.txt",line:1}]
      //   tool_call_update status=completed   rawOutput=…
      //
      // The middle frame has no `status`, so returning null here discarded the
      // arguments AND the real title of ~95% of that adapter's tool calls —
      // which is why they rendered as "Read File" with an empty input while
      // adapters that inline their input on the initial call looked fine.
      return toolCallEnrichment(sessionId, update)
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

/**
 * Best human-readable reason from a failed `session/set_config_option`.
 *
 * The ACP SDK surfaces a server-side rejection as a JSON-RPC `RequestError`
 * whose generic `message` is just "Internal error" (code -32603) — the useful
 * text lives in `error.data.details` (e.g. claude-agent-acp's
 * "Invalid value for config option model: claude-sonnet-4-6"). Prefer that
 * detail, falling back to the error's own message, then a stringified form.
 * Narrows `unknown` with `in`/`typeof` guards — no casts.
 */
function configOptionErrorDetail(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    if ("data" in err && typeof err.data === "object" && err.data !== null) {
      const data = err.data
      if (
        "details" in data &&
        typeof data.details === "string" &&
        data.details.length > 0
      ) {
        return data.details
      }
    }
    if (
      "message" in err &&
      typeof err.message === "string" &&
      err.message.length > 0
    ) {
      return err.message
    }
  }
  return String(err)
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
