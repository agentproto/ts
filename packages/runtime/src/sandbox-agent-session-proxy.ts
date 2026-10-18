/**
 * `AgentSessionLike` proxy over a booted sandbox's OWN agentproto daemon
 * (Option A — see the sandbox-into-agent_start plan). `session-spawn.ts`'s
 * sandbox branch boots the box, calls `host.start()` to run the box's own
 * `agent_start`, and hands the resulting session id here — the registry
 * then treats this proxy exactly like a local adapter's `AgentSessionLike`.
 *
 * `send()` drives the box daemon's session via `agent_prompt`, then
 * subscribes to the box's OWN `GET /sessions/:id/events/stream` SSE
 * endpoint — the same structured event-log records (thought/tool-call/
 * text-delta/turn-end, shaped like `AgentStreamEvent`) a local session's
 * transcript writer produces (`transcript-writer.ts`) — and re-yields them
 * as-is. That shape match is load-bearing: the registry's `runAgentTurn`
 * feeds every yielded event through the SAME transcript-writer +
 * output-ring path it uses for a local session, with no special-casing —
 * so the conversation is captured durably on the HOST side, independent of
 * the (ephemeral) box, WITH full tool-call/usage_update fidelity from the
 * sandboxed adapter (not just flattened text). `agent_output`/`agent_export`
 * keep working after `agent_kill` / box teardown (amendment: conversation
 * survives sandbox teardown).
 *
 * Fallback (documented, not a bug): a box daemon that predates the
 * `/events/stream` route (404) or is simply unreachable degrades this
 * turn to the OLD flattened-text behaviour — polling `agent_output` via
 * `session_monitor`/`agent_prompt`'s ring buffer — rather than failing the
 * turn outright. See `pollAgentOutputFallback`.
 */

import type { SandboxAgentSessionHost, SandboxLifecyclePolicy } from "@agentproto/sandbox"
import type {
  AgentSessionLike,
  AgentStreamEvent,
  SandboxDetachRecord,
  SandboxReattachProbe,
} from "./sessions.js"
import { DEFAULT_CHECKPOINT_INTERVAL_MS } from "./sandbox-delivery.js"
import { recordSandboxReap, recordSandboxState } from "./sandbox-ledger.js"
import type { BoxLoginRefreshOutcome } from "./box-login-bridge.js"

/** `session_monitor`'s max accepted long-poll window (`orchestration-tools.ts`). */
const MAX_POLL_MS = 49_000
/** Pull the full ring-buffer cap each poll so a verbose turn doesn't lose
 *  lines between polls (the ring buffer itself is still capped upstream). */
const MAX_OUTPUT_LINES = 500
/** Give up on the turn only after this many poll failures IN A ROW — a
 *  saturated box (clone + model turn on a small microVM) can stall single
 *  requests past their timeout while the turn itself is healthy. With the
 *  49s window + retry delay this tolerates several minutes of continuous
 *  unreachability before declaring the box dead. */
const MAX_CONSECUTIVE_POLL_FAILURES = 6
/** Pause between failed polls — no tight error loop against a sick box. */
const POLL_RETRY_DELAY_MS = 5_000
/** Box-daemon watchdog defaults: probe `/health` every 30s; declare the daemon
 *  dead after 3 definitive failures in a row (~90s), or after 10 probes in a
 *  row that got no answer at all (~5 min — a box thrashing out of memory). */
export const DEFAULT_WATCHDOG_INTERVAL_MS = 30_000
export const DEFAULT_WATCHDOG_FAILURE_THRESHOLD = 3
export const DEFAULT_WATCHDOG_UNRESPONSIVE_THRESHOLD = 10
const WATCHDOG_PROBE_TIMEOUT_MS = 10_000
/** BOX-LOGIN BRIDGE — minimum gap between attempts to re-upload the box's
 *  login copy. The copy is only rewritten when its digest differs from what
 *  the box holds (the caller's gate), so this bounds the cost of the
 *  re-read + rebuild itself, not the writes. Mirrors {@link BOX_RENEW_THROTTLE_MS}'s
 *  "activity only, throttled, fire-and-forget" discipline. */
export const BOX_LOGIN_REFRESH_THROTTLE_MS = 5 * 60_000

/**
 * A sandbox box that died AT OR PAST its known lifetime deadline while the
 * session was idle. Expected expiry, not a crash: the box's work was
 * already checkpointed/delivered, the idle box was deliberately left to run
 * out its lifetime, and the provider reaped it on schedule. The registry's
 * transport-death listener turns this into `status: "exited"` /
 * `endedReason: "sandbox-expired"` — a clean end with the delivered work
 * branch surfaced as the outcome's artifact — instead of a `crashed` row.
 */
export class SandboxBoxExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SandboxBoxExpiredError"
  }
}

/** True when `err` is (or looks like) a {@link SandboxBoxExpiredError} —
 *  also matches a plain `Error` carrying the same `name`, so the tag
 *  survives serialization across a promise/worker boundary. */
export function isSandboxBoxExpiredError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err instanceof SandboxBoxExpiredError || err.name === "SandboxBoxExpiredError")
  )
}

/** Outcome of one liveness probe:
 *  - `"dead"`: the provider's edge answered non-2xx (daemon not listening,
 *    box gone);
 *  - `"unresponsive"`: no answer within the probe timeout. A busy daemon still
 *    answers `/health` in well under that, but a box swapping itself to death
 *    with no swap (observed: OOM during a parallel build) never does — so a
 *    long enough streak of these is death too;
 *  - `"inconclusive"`: the request failed on the HOST side (DNS, offline) —
 *    says nothing about the box, so it neither counts nor resets a streak. */
export type BoxLiveness = "alive" | "dead" | "unresponsive" | "inconclusive"

/** Probe the box daemon's `/health` over the same origin as `mcpUrl`. Any
 *  HTTP answer that is not 2xx is definitive: the provider's edge answering
 *  502/404 is exactly "VM up (or gone), daemon not listening". */
export async function probeBoxDaemonHealth(mcpUrl: string): Promise<BoxLiveness> {
  const url = new URL(mcpUrl)
  url.pathname = "/health"
  url.search = ""
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(WATCHDOG_PROBE_TIMEOUT_MS) })
    await res.body?.cancel().catch(() => undefined)
    return res.ok ? "alive" : "dead"
  } catch (err) {
    return err instanceof Error && err.name === "TimeoutError" ? "unresponsive" : "inconclusive"
  }
}

/** A host ring-buffer line that looks like the adapter's own failure report —
 *  used to surface a device spawn's first-turn failure (a bad model id ends
 *  the turn EMPTY, with the underlying "model not found"/"invalid model"
 *  line only in the HOST's ring buffer, never in its structured transcript,
 *  so it would otherwise be swallowed across the E2E boundary). Deliberately
 *  narrow: an explicit `[error]`/`[warning]` marker, or the model-resolution
 *  phrasings pi/other adapters print. */
const HOST_ERROR_LINE_RE =
  /\[(?:error|warning)\]|\berror\b|\bwarning\b|invalid model|model not found|unknown model|unsupported model/i

/** Strip CSI/SGR ANSI escape sequences so the marker match sees plain text. */
function stripAnsiCodes(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
}

/**
 * Read the box's raw `agent_output` ring buffer and yield the lines that look
 * like the adapter's own failure report as a single `notice` event — the one
 * channel that lands in the controller's ring buffer (`agent_output`) and
 * durable transcript without counting as assistant text (so the empty-turn
 * classification is preserved). Best-effort: an unreachable box yields
 * nothing rather than failing the turn.
 */
async function* harvestHostErrorNotice(
  host: Pick<SandboxAgentSessionHost, "output">,
  remoteSessionId: string,
): AsyncGenerator<AgentStreamEvent> {
  let tail: string
  try {
    tail = await host.output(remoteSessionId, MAX_OUTPUT_LINES)
  } catch {
    return
  }
  const lines = tail
    .split(/\r?\n/)
    .map(l => stripAnsiCodes(l).trim())
    .filter(l => l.length > 0 && HOST_ERROR_LINE_RE.test(l))
  if (lines.length === 0) return
  yield { kind: "notice", text: lines.join("\n") }
}

/** Record `kind`s the box's transcript writer produces FROM an adapter's
 *  own stream (`transcript-writer.ts`'s `recordEvent` switch) — the exact
 *  set a local session's `send()` can yield. Other on-disk kinds
 *  (`user-prompt`, `system-prompt`, `tool-call-record`, `usage_snapshot`)
 *  are synthesized by the WRITER itself from other call sites, never by
 *  `send()`, so they're skipped rather than re-yielded here. */
const STREAM_EVENT_RECORD_KINDS = new Set([
  "text-delta",
  "thought",
  "tool-call",
  "tool-result",
  "agent-prompt",
  "permission-resolved",
  "turn-end",
  "notice",
  "error",
  "plan",
  "usage_update",
  "available-commands",
])

/**
 * The canonical postures a box session's adapter enforces through its own
 * isolated spawn config, read off the BOX daemon's `agent_start` descriptor
 * (`spawnEnforcedPostures`). `undefined` when the box reported none — an older
 * box daemon, or a non-enforcing adapter — so the host keeps labelling those
 * postures advisory rather than over-claiming a boundary it cannot see.
 */
export function boxSpawnEnforcedPosturesOf(remoteDesc: unknown): string[] | undefined {
  const raw = (remoteDesc as { spawnEnforcedPostures?: unknown } | null | undefined)?.spawnEnforcedPostures
  if (!Array.isArray(raw)) return undefined
  const postures = raw.filter((p): p is string => typeof p === "string" && p.length > 0)
  return postures.length > 0 ? postures : undefined
}

export interface SandboxAgentSessionProxyOpts {
  /** The booted sandbox's daemon host. `prompt`/`output`/`kill`/`waitForAny`
   *  drive the box's OWN `agent_start` session; `stop()`/`pause()` tear the
   *  box down (closes the daemon connection, then stops/pauses the
   *  sandbox) — `pause` is only present when the booted sandbox supports
   *  it (see `BootedSandbox.pause`). `mcpUrl` is the box daemon's own HTTP
   *  origin — reused (not a second client) to reach its
   *  `/sessions/:id/events/stream` route alongside the MCP endpoint. */
  host: Pick<
    SandboxAgentSessionHost,
    | "prompt"
    | "output"
    | "interrupt"
    | "kill"
    | "waitForAny"
    | "currentEventsCursor"
    | "stop"
    | "pause"
    | "mcpUrl"
  > &
    Partial<Pick<SandboxAgentSessionHost, "close" | "extendTimeout" | "lifetimeMs">>
  /** Session id on the BOX's own daemon (from `host.start(...)`) — NOT this
   *  proxy's local session id (the registry mints its own on `spawnAgent`). */
  remoteSessionId: string
  /** Postures the box's adapter enforces through its isolated spawn config,
   *  as the box daemon reported them (`boxSpawnEnforcedPosturesOf`). Surfaced
   *  as the proxy's `spawnEnforcedPostures` so the host's enforcement labels
   *  match what the box actually applies. */
  spawnEnforcedPostures?: readonly string[]
  /** PR3 AIP-36 lifecycle policy (`resolveLifecyclePolicy`) — decides
   *  whether `close()` pauses the box (reuse-friendly, or an explicit
   *  `pause_after_idle`) or kills it. Kill is the default teardown; an
   *  omitted policy ⇒ always kill too, matching PR2. */
  lifecyclePolicy?: SandboxLifecyclePolicy
  /** PLAN-D1 — ledger coordinates for this box. When present, `close()`
   *  stamps the teardown outcome ("paused" vs "stopped") into
   *  `~/.agentproto/sandboxes.json`. Best-effort: a ledger failure never
   *  blocks or fails the teardown. */
  ledger?: { sandboxId: string; provider: string; sessionId?: string }
  /** Device-spawn only: when the box's FIRST turn ends errored or EMPTY,
   *  read the box's raw `agent_output` ring buffer and surface the adapter's
   *  own failure line as a `notice` — the box's structured transcript does
   *  NOT carry it (a bad model id ends the turn empty with the real error
   *  only in the ring buffer), so without this the controller sees a
   *  healthy-looking `running` session with an empty turn and no cause.
   *  Off for every other provider (local/e2b/Box keep byte-identical
   *  behaviour). */
  surfaceHostTurnErrors?: boolean
  /** Device-spawn only (F2 single-dial spawn): the session's FIRST prompt
   *  was already carried INSIDE `host.start()`'s `agent_start` (the
   *  controller's `bootSandboxAgentSession` forwards it), so the proxy must
   *  NOT send it again over a second `agent_prompt` dial. The first `send()`
   *  then only OPENS the box's event stream to consume the already-running
   *  turn; every later `send()` prompts normally. Off for every other
   *  provider (local/e2b/Box keep byte-identical behaviour). */
  promptCarriedInStart?: boolean
  /** BOX-LOGIN BRIDGE — re-upload the box's login copy when the HOST's own
   *  login file changes under a long-lived box (a re-login while this session
   *  runs). Called beside every active-only `renewBoxLifetime()` site, behind
   *  {@link BOX_LOGIN_REFRESH_THROTTLE_MS} and the caller's digest gate (a
   *  byte-identical copy is never rewritten). Skipped once the proxy is
   *  closed or detached — a detached box is nobody's to touch. A rejection is
   *  logged, never thrown: a refresh miss must not fail the turn. Absent for
   *  every spawn whose boot-time upload didn't happen (see
   *  `session-spawn.ts`'s degrade path) and for every non-file-based login. */
  refreshLoginFile?: () => Promise<BoxLoginRefreshOutcome>
  /** Runs once in `close()`, after the box's agent session is killed and
   *  before the box is stopped or paused — the last moment its filesystem is
   *  still reachable. A rejection is swallowed: delivery trouble never blocks
   *  the teardown it precedes. Skipped when the daemon itself is shutting
   *  down (`close({ daemonShutdown: true })`): the process is about to exit,
   *  so the box is released at once instead. */
  onBeforeTeardown?: () => Promise<void>
  /** Opt in to surviving a host-daemon restart: `detach()` then closes only
   *  the connection (box session and box left running) and the session can
   *  be re-attached at the next boot. Off for device sandboxes (their box
   *  daemon is reached through a paired host, not a provider box). */
  detachable?: boolean
  /** Re-attach only: the box-transcript `seq` already consumed on the host
   *  before the restart — the event stream resumes after it. */
  initialTranscriptCursor?: number
  /** Periodic checkpoint of the box's work (`createSandboxCheckpointer`): run
   *  every `intervalMs`, after each turn, and once more when the watchdog
   *  declares the box daemon dead (the VM often outlives its daemon, and its
   *  filesystem is still reachable through the provider). Stops at `close()`,
   *  which awaits an in-flight run before its own teardown delivery. A
   *  rejection is swallowed. `run`'s `turn` is the number of turns the proxy
   *  has completed so far, stamped onto the checkpoint record. */
  checkpoint?: { run: (turn?: number) => Promise<unknown>; intervalMs?: number }
  /** Box-daemon liveness watchdog. Without it a daemon that dies BETWEEN
   *  turns (OOM-killed in a small box) leaves the host row `running` forever:
   *  nothing reads the box until the next prompt. When `failureThreshold`
   *  definitive probe failures land in a row, the proxy takes a last
   *  checkpoint and fires `onDisconnect`, which the registry turns into a
   *  `crashed` row — restartable, and eligible for `restartPolicy`. */
  watchdog?: {
    probe?: () => Promise<BoxLiveness>
    intervalMs?: number
    /** Consecutive `"dead"` probes before declaring death. */
    failureThreshold?: number
    /** Consecutive `"dead"`/`"unresponsive"` probes before declaring death. */
    unresponsiveThreshold?: number
    /** When the box's known lifetime deadline has already passed when the
     *  watchdog declares death (an idle box left to expire — the designed
     *  lifecycle), the `onDisconnect` error is tagged
     *  `SandboxBoxExpiredError` so the registry ends the row with
     *  `endedReason: "sandbox-expired"` / `status: "exited"` instead of
     *  `crashed`. */
  }
}

/** A re-attach replay of an idle box (unseen backlog, no turn in flight) ends
 *  after this much silence — the backlog is finite, so quiet means done. */
const REPLAY_QUIET_END_MS = 10_000

/** How long a detached box is asked to stay alive — requested from the
 *  moment of detach. Providers cap this on their own (e2b hobby: 1h); a
 *  rejected request leaves the box's original deadline in place. */
export const DETACHED_BOX_LIFETIME_MS = 60 * 60_000

/** Activity renewals re-arm the box at most this often. */
export const BOX_RENEW_THROTTLE_MS = 60_000
/** Renewal lifetime when the host reports none (`host.lifetimeMs` unset). */
export const DEFAULT_BOX_RENEW_LIFETIME_MS = 45 * 60_000
/** While a turn is in flight the box is re-armed at least this often, events
 *  or not. Event-driven renewal alone misses a turn that streams nothing for
 *  a long time (one long tool call — a monorepo build): the box hit its
 *  45-min deadline mid-turn that way (sess_07610979, 2026-10-13). */
export const BOX_ACTIVE_RENEW_INTERVAL_MS = 10 * 60_000
/** How long before the box's known deadline the deadline guard acts: one
 *  last renewal attempt if a turn is in flight, else (or if it fails) a final
 *  checkpoint while the box's filesystem is still reachable. Capped at a third
 *  of the lifetime for short-lived boxes. */
export const BOX_DEADLINE_GUARD_LEAD_MS = 5 * 60_000

/** Upper bound on the final checkpoint an idle reap runs before tearing the
 *  box down: a checkpoint that hangs must not keep an idle box alive. */
export const IDLE_REAP_CHECKPOINT_TIMEOUT_MS = 2 * 60_000

/**
 * Best-effort extraction of the prompt text from whatever `sessions.ts`'s
 * `runAgentTurn` hands `AgentSessionLike.send()` — today always either a
 * bare string, or the ACP-style `{type:"text", text}` block `runAgentTurn`
 * wraps a string message into before calling `send()`.
 */
function extractPromptText(message: unknown): string {
  if (typeof message === "string") return message
  if (message && typeof message === "object" && "text" in message) {
    const text = (message as { text?: unknown }).text
    if (typeof text === "string") return text
  }
  return JSON.stringify(message)
}

/** Build the box daemon's own `GET /sessions/:id/events/stream` URL —
 *  same host:port as `mcpUrl` (the daemon's HTTP server serves both), just
 *  a different path. `since` is the PER-SESSION transcript seq to resume
 *  after — a different cursor space than `currentEventsCursor()`'s
 *  daemon-wide event-bus cursor (that one feeds `session_monitor`, this
 *  one feeds the session's own `events.jsonl`). */
function buildEventsStreamUrl(mcpUrl: string, remoteSessionId: string, since: number): string {
  const url = new URL(mcpUrl)
  url.pathname = `/sessions/${encodeURIComponent(remoteSessionId)}/events/stream`
  url.search = `since=${since}`
  return url.toString()
}

function boxSessionUrl(mcpUrl: string, remoteSessionId: string, suffix: string, search = ""): string {
  const url = new URL(mcpUrl)
  url.pathname = `/sessions/${encodeURIComponent(remoteSessionId)}${suffix}`
  url.search = search
  return url.toString()
}

/** Page size for the finite backlog read in `probeReattach`. */
const PROBE_BACKLOG_LIMIT = 500
const PROBE_TIMEOUT_MS = 10_000

/**
 * Classify the box's session for a re-attaching host. Uses only the box
 * daemon's own read routes (`GET /sessions/:id` for liveness + busy, the
 * finite `GET /sessions/:id/events?since=` for the unseen backlog) — never a
 * prompt. Never throws: any transport failure is `unreachable`.
 */
async function probeBoxSession(
  mcpUrl: string,
  remoteSessionId: string,
  since: number,
): Promise<SandboxReattachProbe> {
  const get = async (url: string): Promise<Response> =>
    fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  try {
    const res = await get(boxSessionUrl(mcpUrl, remoteSessionId, ""))
    if (res.status === 404) return { state: "gone" }
    if (!res.ok) return { state: "unreachable", detail: `GET session returned ${res.status}` }
    const desc = (await res.json()) as { busy?: boolean; status?: string }
    const status = desc.status
    const finished = status === "killed" || status === "exited" || status === "error"
    if (desc.busy === true && !finished) return { state: "busy" }
    const evRes = await get(
      boxSessionUrl(mcpUrl, remoteSessionId, "/events", `since=${since}&limit=${PROBE_BACKLOG_LIMIT}`),
    )
    let backlog = false
    if (evRes.ok) {
      const body = (await evRes.json()) as { events?: Array<Record<string, unknown>> }
      backlog = (body.events ?? []).some(
        r => typeof r.kind === "string" && STREAM_EVENT_RECORD_KINDS.has(r.kind),
      )
    }
    if (finished) return { state: "ended", detail: `box session status "${status}"` }
    return { state: backlog ? "backlog" : "idle" }
  } catch (err) {
    return { state: "unreachable", detail: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Open the box daemon's structured SSE stream. Throws (caller falls back to
 * `pollAgentOutputFallback`) when the box is unreachable or its daemon
 * predates the route (404) — the ONLY case this proxy degrades on, per the
 * module doc.
 */
async function openBoxEventStream(
  mcpUrl: string,
  remoteSessionId: string,
  since: number,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const url = buildEventsStreamUrl(mcpUrl, remoteSessionId, since)
  const res = await fetch(url, { headers: { accept: "text/event-stream" }, signal })
  if (!res.ok || !res.body) {
    throw new Error(`sandbox proxy: GET ${url} returned ${res.status}`)
  }
  return res.body
}

/**
 * Parse `GET /sessions/:id/events/stream`'s `data: <json>\n\n` frames off
 * an already-open SSE body — same framing the CLI's own SSE consumers
 * parse (`cli/src/commands/sessions.ts`'s dashboard `/events` reader).
 * `:`-prefixed comment lines (the route's `: connected`/`: keep-alive`
 * pings) are not `data:` lines and fall out of the filter naturally.
 */
/** Re-yield `records`, but end quietly (`state.quiet = true`) once `ms` pass
 *  with nothing arriving. Used for a re-attach replay of events the box
 *  produced while the host was down, when the box is NOT mid-turn: the
 *  backlog is finite, so silence means it was fully replayed. */
async function* endAfterQuiet(
  records: AsyncGenerator<Record<string, unknown>>,
  ms: number,
  state: { quiet: boolean },
): AsyncGenerator<Record<string, unknown>> {
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const next = await Promise.race([
      records.next(),
      new Promise<"quiet">(resolve => {
        timer = setTimeout(() => resolve("quiet"), ms)
      }),
    ])
    clearTimeout(timer)
    if (next === "quiet") {
      state.quiet = true
      void records.return(undefined).catch(() => undefined)
      return
    }
    if (next.done) return
    yield next.value
  }
}

async function* readSseRecords(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buf += decoder.decode(value, { stream: true })
      let idx = buf.indexOf("\n\n")
      while (idx !== -1) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue
          const payload = line.slice("data:".length).trim()
          if (!payload) continue
          try {
            yield JSON.parse(payload) as Record<string, unknown>
          } catch {
            // Malformed frame — tolerate, same as the CLI's own SSE readers.
          }
        }
        idx = buf.indexOf("\n\n")
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

/**
 * Map an `events.jsonl` record back onto the `AgentStreamEvent` shape
 * `send()` must yield — the inverse of `transcript-writer.ts`'s
 * `recordEvent`, which writes these records FROM an `AgentStreamEvent` in
 * the first place, so every field beyond the bookkeeping ones
 * (`seq`/`ts`/`sessionId`/the debounce-only `partial` marker) carries over
 * unchanged. Returns `undefined` for record kinds `send()` never yields
 * (`user-prompt`, `system-prompt`, `tool-call-record`, `usage_snapshot` —
 * synthesized by the writer's OTHER methods, not `recordEvent`) or for a
 * malformed/unrecognized record.
 */
function recordToStreamEvent(record: Record<string, unknown>): AgentStreamEvent | undefined {
  const kind = record.kind
  if (typeof kind !== "string" || !STREAM_EVENT_RECORD_KINDS.has(kind)) return undefined
  const { seq: _seq, ts: _ts, sessionId: _sessionId, partial: _partial, ...rest } = record
  return { ...rest, kind } as AgentStreamEvent
}

/**
 * Legacy fallback: flatten the box's `agent_output` ring-buffer tail into
 * plain text-delta events, exactly as this proxy did before the structured
 * SSE stream existed. Used only when `openBoxEventStream` fails — a box
 * daemon whose `/sessions/:id/events/stream` route 404s (predates it) or
 * is simply unreachable — so a fresh/older box still degrades gracefully
 * instead of failing the turn (see module doc).
 */
async function* pollAgentOutputFallback(
  host: Pick<SandboxAgentSessionHost, "output" | "waitForAny">,
  remoteSessionId: string,
  since: number,
): AsyncGenerator<AgentStreamEvent> {
  // The offset is a character offset into the raw joined string — NOT a
  // line count. `projectEvent`'s text-delta handling expects
  // newline-delimited STREAM FRAGMENTS it coalesces itself (partial lines
  // included); re-splitting the tail into whole lines here and yielding
  // each separately (with the splitting newline stripped) would feed it
  // back newline-less chunks that get glued into one mangled line instead.
  // Yielding the raw new suffix (embedded newlines intact) lets that same
  // coalescing logic split it correctly.
  let seenLength = 0
  try {
    // Transient-failure tolerance: a single failed poll request must NOT
    // kill the turn. A long review turn saturates a small box (monorepo
    // clone + model generation), stalling its daemon's event loop past the
    // client's per-request timeout — `MCP error -32001` — while the turn
    // itself is perfectly healthy (observed in CI, ~2min in). Each poll is
    // a bounded request, but the TURN is the loop: retry after a short
    // pause, and only give up after MAX_CONSECUTIVE_POLL_FAILURES in a row
    // (a genuinely dead/unreachable box still errors, with the last
    // failure's message).
    let consecutivePollFailures = 0
    for (;;) {
      let result: Awaited<ReturnType<typeof host.waitForAny>>
      try {
        // `since` (reused unchanged across retries — a timeout means
        // nothing has matched since that cursor yet, so there's nothing to
        // advance) is what makes this race-free; the subscription timing
        // itself no longer matters.
        result = await host.waitForAny([remoteSessionId], {
          event: "any",
          timeoutMs: MAX_POLL_MS,
          since,
        })
        consecutivePollFailures = 0
      } catch (pollErr) {
        consecutivePollFailures++
        if (consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          throw new Error(
            `sandbox proxy: ${consecutivePollFailures} consecutive poll failures against the ` +
              `box daemon (session "${remoteSessionId}") — giving up. Last error: ` +
              `${pollErr instanceof Error ? pollErr.message : String(pollErr)}`,
          )
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_RETRY_DELAY_MS))
        continue
      }
      // A clean long-poll timeout carries no `event` at all — keep polling
      // past it instead of mistaking it for a real settle (mirrors
      // `@agentproto/worktree`'s `waitForSettled`).
      if (result.timedOut) continue

      // The tail pull is best-effort: the offset-based diff means a failed
      // pull loses nothing — a later successful pull (or the catch's final
      // harvest below) yields the full unseen suffix. One immediate retry,
      // then proceed without it rather than killing a settled turn over a
      // missed output read.
      let tail: string | undefined
      try {
        tail = await host.output(remoteSessionId, MAX_OUTPUT_LINES)
      } catch {
        try {
          tail = await host.output(remoteSessionId, MAX_OUTPUT_LINES)
        } catch {
          tail = undefined
        }
      }
      if (tail !== undefined && tail.length > seenLength) {
        yield { kind: "text-delta", text: tail.slice(seenLength) }
      }
      if (tail !== undefined) seenLength = tail.length

      if (result.event === "exited") {
        // The box's OWN session ended out-of-band (crash, OOM, an
        // independent kill) — not a normal turn boundary. Throwing here
        // (rather than yielding a turn-end) lets the registry's existing
        // `runAgentTurn` catch flip this session's status to "error" and
        // emit `session:exited`, the same "proxy detects remote exit"
        // behaviour a local adapter crash gets today — no new plumbing.
        throw new Error(
          `sandbox proxy: remote session "${remoteSessionId}" exited — the box's own ` +
            "agentproto daemon ended this session (crash, OOM, or an out-of-band kill).",
        )
      }
      yield {
        kind: "turn-end",
        reason: result.event === "awaiting-input" ? "awaiting-input" : "completed",
      }
      return
    }
  } catch (err) {
    // Final harvest before the error propagates: pull whatever the box
    // printed that this turn hasn't yielded yet, so the HOST transcript
    // and ring buffer carry the box session's last words (stack traces,
    // adapter stderr, partial thoughts). Without this, a failure between
    // polls — or a thrown `host.prompt`/`waitForAny` — left the host side
    // EMPTY and post-mortem diagnosis blind (observed in CI: a box session
    // erroring ~2min in with zero surfaced output). Best-effort: the box
    // may already be unreachable.
    try {
      const tail = await host.output(remoteSessionId, MAX_OUTPUT_LINES)
      if (tail.length > seenLength) {
        yield { kind: "text-delta", text: tail.slice(seenLength) }
      }
    } catch {
      // box gone — nothing more to salvage
    }
    throw err
  }
}

/**
 * Build an `AgentSessionLike` over a box daemon's own `agent_start` session.
 * See module docs for the structured-stream/fallback split and the
 * cancel-semantics note below.
 */
export function createSandboxAgentSessionProxy(
  opts: SandboxAgentSessionProxyOpts,
): AgentSessionLike {
  const { host, remoteSessionId, lifecyclePolicy } = opts
  let closed = false
  // Set by `detach()` at host-daemon shutdown. Once true the proxy never
  // touches the box session again: the open stream is aborted and every
  // in-flight `send()` parks (see `parkIfDetached`).
  let detached = false
  let activeController: AbortController | undefined
  // This session's own transcript-seq cursor — a DIFFERENT space than
  // `currentEventsCursor()`'s daemon-wide event-bus cursor (that one feeds
  // `session_monitor`; this one feeds `GET /sessions/:id/events/stream`).
  // Starts at 0: `host.start()` never sends a prompt of its own
  // (`session-spawn.ts` calls it with no `prompt`), so the very first
  // `send()` call is this session's first turn and there is no prior
  // transcript to skip — unless this proxy re-attaches after a host restart,
  // where it starts at the last seq the previous host process consumed.
  // Advanced to the last consumed record's `seq` after every record (in the
  // closure, so it persists across turns) so a later turn's stream only
  // replays what's new — no extra round-trip needed to discover "current
  // tip" the way `currentEventsCursor()` does for the bus, since nothing
  // else writes to THIS session's transcript concurrently.
  let transcriptCursor = opts.initialTranscriptCursor ?? 0
  // How many turns this proxy has driven — gates the first-turn-only host
  // error surfacing (see `surfaceHostTurnErrors`).
  let turnsSent = 0
  let lastProbeState: SandboxReattachProbe["state"] | undefined
  let lastRenewAt = 0
  // Turns currently in flight on the box (a live `send()`, or a re-attach to
  // a busy box). A prompt the registry queues behind a running turn is
  // delivered by the next `send()` as soon as this one ends, so "a turn is in
  // flight" also covers "a prompt is waiting".
  let activeTurns = 0
  const boxLifetimeMs = host.lifetimeMs ?? DEFAULT_BOX_RENEW_LIFETIME_MS
  // The box's deadline as far as this proxy knows: its lifetime from creation
  // (the box was booted or re-armed by `connect` just before), pushed out by
  // every renewal the provider accepts.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  // The absolute timestamp of the box's NEXT lifetime deadline as this proxy
  // knows it — `boxLifetimeMs` from the last arm/rearm (renewals the provider
  // accepted nudge it forward, a rejected renewal leaves it). The watchdog
  // consults it when the box dies: death AT/PAST this deadline is expected
  // expiry, not a crash.
  let nextDeadlineAt: number | undefined

  /** Re-arm the box's lifetime because the session is actively working.
   *  Throttled, fire-and-forget; a failed renewal is logged, never thrown.
   *  Only called on activity — an idle box is left to expire. */
  const renewBoxLifetime = (): void => {
    if (!host.extendTimeout || closed || detached) return
    const now = Date.now()
    if (now - lastRenewAt < BOX_RENEW_THROTTLE_MS) return
    lastRenewAt = now
    try {
      host.extendTimeout(boxLifetimeMs).then(
        () => armDeadlineGuard(now + boxLifetimeMs),
        err => {
          console.warn("[sandbox-proxy] failed to renew box lifetime:", err)
        },
      )
    } catch (err) {
      console.warn("[sandbox-proxy] failed to renew box lifetime:", err)
    }
  }

  /** Schedule the deadline guard ahead of `deadlineAt`, replacing any earlier
   *  one. When it fires and a turn is still in flight it makes one last
   *  renewal attempt; when the session is idle, or that renewal fails too, it
   *  runs a final checkpoint — the box is about to be reaped, and a
   *  checkpoint taken after the deadline only finds "Sandbox is probably not
   *  running anymore". Inert for providers without `extendTimeout`. */
  function armDeadlineGuard(deadlineAt: number): void {
    if (!host.extendTimeout || closed || detached) return
    nextDeadlineAt = deadlineAt
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
    const lead = Math.min(BOX_DEADLINE_GUARD_LEAD_MS, Math.floor(boxLifetimeMs / 3))
    deadlineTimer = setTimeout(() => void onDeadlineNear(), Math.max(0, deadlineAt - lead - Date.now()))
    deadlineTimer.unref?.()
  }

  async function onDeadlineNear(): Promise<void> {
    deadlineTimer = undefined
    if (closed || detached) return
    if (activeTurns > 0 && host.extendTimeout) {
      const now = Date.now()
      try {
        await host.extendTimeout(boxLifetimeMs)
        lastRenewAt = now
        armDeadlineGuard(now + boxLifetimeMs)
        return
      } catch (err) {
        console.warn("[sandbox-proxy] failed to renew box lifetime before its deadline:", err)
      }
    }
    if (closed || detached || !opts.checkpoint) return
    console.warn(
      `[sandbox-proxy] box for remote session "${remoteSessionId}" reaches its lifetime deadline ` +
        "without a renewal — running a final checkpoint while it is still reachable",
    )
    await runCheckpoint(turnsSent)
  }

  /** BOX-LOGIN BRIDGE — re-upload the box's login copy because this session
   *  is actively working and the HOST's login file may have changed under it.
   *  Throttled, fire-and-forget, and gated exactly like `renewBoxLifetime`:
   *  never after `close()`/`detach()`, never for a box nobody is driving. A
   *  rejection is logged (naming nothing but the failure), never thrown. */
  let lastLoginRefreshAt = 0
  const refreshLoginFile = (): void => {
    if (!opts.refreshLoginFile || closed || detached) return
    const now = Date.now()
    if (now - lastLoginRefreshAt < BOX_LOGIN_REFRESH_THROTTLE_MS) return
    lastLoginRefreshAt = now
    try {
      opts.refreshLoginFile().catch(err => {
        console.warn("[sandbox-proxy] failed to refresh the box login file:", err)
      })
    } catch (err) {
      console.warn("[sandbox-proxy] failed to refresh the box login file:", err)
    }
  }

  /** After a detach every path out of an in-flight turn lands here and never
   *  returns: a throw or a normal return would make the registry's turn loop
   *  record a synthetic turn-end / error status for a session that is in
   *  fact alive on its box. The process is exiting; the pending promise dies
   *  with it. */
  const parkIfDetached = async (): Promise<void> => {
    if (detached) await new Promise<never>(() => undefined)
  }

  /** Consume the box's structured stream for ONE turn (prompt already sent,
   *  or already running on the box). Shared by `send()` and `resumeTurn()`. */
  async function* consumeTurn(
    isFirstTurn: boolean,
    since: number,
    quietEndMs?: number,
  ): AsyncGenerator<AgentStreamEvent> {
    const controller = new AbortController()
    activeController = controller
    let sseBody: ReadableStream<Uint8Array> | undefined
    try {
      sseBody = await openBoxEventStream(
        host.mcpUrl,
        remoteSessionId,
        transcriptCursor,
        controller.signal,
      )
    } catch {
      // Unreachable box, or a daemon old enough to 404 the route —
      // degrade to the flattened poll rather than failing the turn.
      sseBody = undefined
    }
    await parkIfDetached()

    if (!sseBody) {
      try {
        for await (const evt of pollAgentOutputFallback(host, remoteSessionId, since)) {
          if (quietEndMs === undefined) {
            renewBoxLifetime()
            refreshLoginFile()
          }
          yield evt
        }
      } catch (err) {
        await parkIfDetached()
        throw err
      }
      return
    }

    try {
      let sawTurnEnd = false
      let sawAssistantText = false
      let sawToolCall = false
      const quietState = { quiet: false }
      const source =
        quietEndMs === undefined
          ? readSseRecords(sseBody)
          : endAfterQuiet(readSseRecords(sseBody), quietEndMs, quietState)
      for await (const record of source) {
        if (typeof record.seq === "number") transcriptCursor = record.seq
        const evt = recordToStreamEvent(record)
        if (!evt) continue
        // An idle re-attach replay (`quietEndMs` set) is stale backlog, not work.
        if (quietEndMs === undefined) {
          renewBoxLifetime()
          refreshLoginFile()
        }
        if (evt.kind === "text-delta" && evt.text?.trim()) sawAssistantText = true
        else if (evt.kind === "tool-call") sawToolCall = true
        if (evt.kind === "turn-end") {
          sawTurnEnd = true
          // Device first-turn failure surfacing: the box's structured
          // transcript carries no cause for an EMPTY turn (a bad model id),
          // and an `error` reason may have its message only in the box's
          // ring buffer. Pull that raw line into the controller's view
          // BEFORE the terminal turn-end so it reads as part of this turn.
          if (
            opts.surfaceHostTurnErrors &&
            isFirstTurn &&
            (evt.reason === "error" || (!sawAssistantText && !sawToolCall))
          ) {
            yield* harvestHostErrorNotice(host, remoteSessionId)
          }
          yield evt
          break
        }
        yield evt
      }
      await parkIfDetached()
      if (!sawTurnEnd && !quietState.quiet) {
        // The connection closed (box HTTP server gone, not just the
        // adapter subprocess) without a terminal turn-end record ever
        // landing. The box's OWN `runAgentTurn` guarantees a turn-end
        // (real or synthesized) for any outcome it can observe — a
        // stream that ends without one means the box daemon itself
        // stopped observing, i.e. it's gone. Throwing here mirrors the
        // fallback path's "exited" handling: the registry's
        // `runAgentTurn` catch flips this session's status to "error"
        // and emits `session:exited`.
        throw new Error(
          `sandbox proxy: structured event stream for remote session "${remoteSessionId}" ` +
            "ended without a turn-end — the box's own agentproto daemon connection was " +
            "lost (crash, OOM, or an out-of-band kill).",
        )
      }
    } catch (err) {
      await parkIfDetached()
      // Best-effort final harvest, same rationale as the legacy fallback's
      // catch: pull whatever the box printed that this turn hasn't
      // yielded as a structured event, so the HOST transcript isn't left
      // blind. May overlap with content already yielded above — an
      // acceptable duplicate on an already-abnormal turn, not a silent
      // gap.
      try {
        const tail = await host.output(remoteSessionId, MAX_OUTPUT_LINES)
        if (tail) yield { kind: "text-delta", text: tail }
      } catch {
        // box gone — nothing more to salvage
      }
      throw err
    } finally {
      controller.abort()
      if (activeController === controller) activeController = undefined
    }
  }

  // ── checkpoint + watchdog (both optional, both stop at close/death) ──
  let checkpointInFlight: Promise<unknown> | undefined
  // `turnsSent` at call time — the number of turns completed so far — is
  // stamped onto the checkpoint record/commit message as a breadcrumb; a
  // coalesced call (one already in flight) keeps whichever turn started it.
  const runCheckpoint = (turn?: number): Promise<unknown> => {
    if (!opts.checkpoint) return Promise.resolve()
    if (checkpointInFlight) return checkpointInFlight
    checkpointInFlight = opts.checkpoint
      .run(turn)
      .catch(() => undefined)
      .finally(() => {
        checkpointInFlight = undefined
      })
    return checkpointInFlight
  }
  const timers: ReturnType<typeof setInterval>[] = []
  const stopTimers = () => {
    for (const timer of timers.splice(0)) clearInterval(timer)
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
    deadlineTimer = undefined
    nextDeadlineAt = undefined
  }
  if (host.extendTimeout) {
    // Heartbeat: re-arm the box on a fixed cadence while a turn is in flight,
    // whether or not it streams anything (see BOX_ACTIVE_RENEW_INTERVAL_MS).
    const timer = setInterval(() => {
      if (activeTurns > 0) renewBoxLifetime()
    }, BOX_ACTIVE_RENEW_INTERVAL_MS)
    timer.unref?.()
    timers.push(timer)
    armDeadlineGuard(Date.now() + boxLifetimeMs)
  }
  if (opts.checkpoint) {
    const timer = setInterval(() => {
      if (!closed && !detached) void runCheckpoint(turnsSent)
    }, opts.checkpoint.intervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS)
    timer.unref?.()
    timers.push(timer)
  }
  let deadError: Error | undefined
  const disconnectListeners: Array<(err: Error) => void> = []
  if (opts.watchdog) {
    const probe = opts.watchdog.probe ?? (() => probeBoxDaemonHealth(host.mcpUrl))
    const threshold = opts.watchdog.failureThreshold ?? DEFAULT_WATCHDOG_FAILURE_THRESHOLD
    const unresponsiveThreshold =
      opts.watchdog.unresponsiveThreshold ?? DEFAULT_WATCHDOG_UNRESPONSIVE_THRESHOLD
    let failures = 0
    let silent = 0
    let probing = false
    const timer = setInterval(() => {
      if (closed || probing || deadError) return
      probing = true
      void (async () => {
        try {
          const liveness = await probe().catch((): BoxLiveness => "inconclusive")
          if (closed || deadError) return
          if (liveness === "alive") {
            failures = 0
            silent = 0
          } else if (liveness === "dead") {
            failures++
            silent++
          } else if (liveness === "unresponsive") {
            failures = 0
            silent++
          }
          if (failures < threshold && silent < unresponsiveThreshold) return
          // Capture the deadline BEFORE stopTimers() — it clears
          // `nextDeadlineAt`, and the expiry check below would never see it.
          const knownDeadlineAt = nextDeadlineAt
          stopTimers()
          // An idle box whose DEADLINE has already passed was deliberately
          // left to expire — the provider reaping it then is the expected
          // lifecycle, not a crash (sess_795b8c58 / e39cd4da / 7d29436b,
          // 2026-10-16: three e2b sessions ended exactly at the box's 1h
          // account cap after the work was delivered, misclassified as
          // "crashed"). Tag the death so the registry ends the row with
          // `endedReason: "sandbox-expired"` instead of `crashed`.
          const expired = knownDeadlineAt !== undefined && Date.now() >= knownDeadlineAt
          deadError = expired
            ? new SandboxBoxExpiredError(
                `sandbox box for remote session "${remoteSessionId}" reached its ` +
                  `${Math.round(boxLifetimeMs / 60_000)}-minute lifetime deadline while idle — ` +
                  "the provider reaped it as scheduled (expected expiry, not a crash; " +
                  "work was left delivered by the session's checkpoints).",
              )
            : new Error(
                `sandbox proxy: the box daemon for remote session "${remoteSessionId}" ` +
                  (failures >= threshold
                    ? `failed its health check ${failures} times in a row`
                    : `did not answer its health check ${silent} times in a row`) +
                  " (crash, OOM, or the box is gone).",
              )
          // Last-chance rescue while the VM may still be up.
          await runCheckpoint(turnsSent)
          if (closed) return
          for (const listener of disconnectListeners.splice(0)) {
            try {
              listener(deadError)
            } catch {
              // a listener's failure is its own
            }
          }
        } finally {
          probing = false
        }
      })()
    }, opts.watchdog.intervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS)
    timer.unref?.()
    timers.push(timer)
  }

  async function* sendTurn(message: unknown): AsyncGenerator<AgentStreamEvent> {
    const prompt = extractPromptText(message)
    const isFirstTurn = turnsSent === 0
    turnsSent++

    // Capture a race-free cursor BEFORE sending: an extremely fast turn
    // (a synchronous/near-instant adapter echo is plausible for a
    // trivial prompt) can settle and fire its `session:turn-end` before
    // `waitForAny`'s own long-poll request even reaches the box daemon
    // over the network — client-side call ORDERING alone can't close
    // this (two outbound HTTP requests racing to the same daemon have no
    // guaranteed arrival order). The awaited cursor fetch completes
    // strictly before `prompt` is sent, so the box daemon's ring-replay
    // branch (`orchestration-tools.ts`'s `monitorSessionWait`) always
    // finds the matching turn-end regardless of how late the long-poll's
    // bus subscription lands — see `HarnessClient.currentEventsCursor`'s
    // doc. Only consumed by `pollAgentOutputFallback` below, but always
    // captured up front (mirrors `@agentproto/worktree`'s
    // `sendPromptAndWait`, which uses the same cursor-first pattern)
    // so a mid-turn fallback never starts from a stale cursor.
    let since: number
    try {
      since = await host.currentEventsCursor()
      // F2 single-dial spawn: the first prompt rode inside `host.start()`'s
      // `agent_start`, so re-sending it here would be the second concurrent
      // `forwardHttpStream` dial this fix removes (and would double-deliver
      // the turn). Just consume the stream below.
      if (!(opts.promptCarriedInStart && isFirstTurn)) {
        renewBoxLifetime()
        refreshLoginFile()
        await host.prompt(remoteSessionId, prompt)
      }
    } catch (err) {
      await parkIfDetached()
      throw err
    }
    await parkIfDetached()
    yield* consumeTurn(isFirstTurn, since)
  }

  const proxy: AgentSessionLike = {
    sessionId: remoteSessionId,
    ...(opts.spawnEnforcedPostures && opts.spawnEnforcedPostures.length > 0
      ? { spawnEnforcedPostures: [...opts.spawnEnforcedPostures] }
      : {}),

    ...(opts.watchdog
      ? {
          isConnected: () => deadError === undefined,
          onDisconnect(listener: (err: Error) => void): void {
            if (deadError) listener(deadError)
            else disconnectListeners.push(listener)
          },
        }
      : {}),

    async *send(message: unknown): AsyncIterable<AgentStreamEvent> {
      activeTurns++
      try {
        yield* sendTurn(message)
      } finally {
        activeTurns--
        // Each turn's end — clean or not — is a natural checkpoint: the
        // agent just stopped writing. Never awaited: the turn is over.
        if (!closed && !detached) void runCheckpoint(turnsSent)
      }
    },

    async cancel(): Promise<void> {
      if (closed || detached) return
      // Cancel the box's turn via its MODEL MCP tool `agent_interrupt` — the
      // same channel `prompt`/`agent_start` already authenticate fine — never
      // the raw `POST /sessions/:id/interrupt` HTTP route: every mutating
      // `/sessions/*` route on the box daemon gates ALL POSTs behind the
      // per-boot bearer token this host never holds (the box's own
      // runtime.json token), and that 401'd every interrupt from a remote
      // sandbox — steering, queue forcing and turnRetry alike. `agent_prompt
      // interrupt:true`'s redirect prompt (or the replacement's delivery, on
      // this same interrupts-without-prompt path) must not carry an
      // `interrupt` flag either: re-sending the previous prompt with
      // `interrupt: true` restarts that request before the registry can
      // deliver the replacement, and contaminates its stream.
      await host.interrupt(remoteSessionId)
    },

    async close(closeOpts?: {
      daemonShutdown?: boolean
      idleReap?: { idleMs: number; sessionId?: string }
    }): Promise<void> {
      if (closed) return
      closed = true
      stopTimers()
      // IDLE REAP: take a final checkpoint of the box's uncommitted work while
      // its filesystem is still reachable — the teardown below is what ends the
      // box, and the reaped session's only way back is a cold boot from this
      // checkpoint. Bounded so a hung checkpoint can never keep the box alive.
      if (closeOpts?.idleReap && !detached && opts.checkpoint) {
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          runCheckpoint(turnsSent),
          new Promise<void>(resolve => {
            timer = setTimeout(resolve, IDLE_REAP_CHECKPOINT_TIMEOUT_MS)
            timer.unref?.()
          }),
        ])
        if (timer) clearTimeout(timer)
        // Timed out: stop waiting on the straggler below as well.
        checkpointInFlight = undefined
      }
      // Let a running checkpoint finish before the teardown delivery reuses
      // the same snapshot ref and pushes.
      await checkpointInFlight?.catch(() => undefined)
      // A detached proxy must never kill the box session it deliberately
      // left running (a late safety-net close on the way out of the process).
      if (detached) return
      // PAUSE (not kill) when the lifecycle policy says this box is
      // meant to be reused later — falls back to `stop()` when the
      // provider never exposed a `pause()` (e.g. `local`, or a policy
      // that resolved to "pause" against a non-pausable provider): a
      // teardown must never silently no-op and leak the box.
      const pauseFn = lifecyclePolicy?.teardown === "pause" ? host.pause : undefined
      const pauseTeardown = pauseFn !== undefined
      // AIP-36 shared-box amendment — teardown = DETACH first, destroy last:
      // only the LAST live session to close() tears the box down (stop/pause
      // + ledger terminal stamp); the others leave it running. No ledger
      // coordinates (or no sessionId on them) ⇒ solo teardown as before.
      try {
        await host.kill(remoteSessionId)
      } finally {
        try {
          if (closeOpts?.daemonShutdown !== true) await opts.onBeforeTeardown?.()
        } catch {
          // best-effort — see `onBeforeTeardown`
        }
        try {
          // AIP-36 shared-box amendment — the ledger row is the refcount.
          // With OTHER sessions still attached, detach only: the box is
          // neither stopped nor paused (it keeps running under the
          // survivors), and no terminal state is stamped.
          const remaining =
            opts.ledger?.sandboxId && opts.ledger?.sessionId
              ? recordSessionDetach(opts.ledger.sandboxId, opts.ledger.sessionId)
              : []
          if (remaining.length > 0) return
          if (pauseFn) {
            await pauseFn()
          } else {
            await host.stop()
          }
        } finally {
          // PLAN-D1 — stamp the teardown outcome into the sandbox ledger.
          // Inside the finally chain so even a failing teardown records
          // (best-effort: `recordSandboxState` itself never throws).
          if (opts.ledger) {
            const finalState = pauseTeardown ? "paused" : "stopped"
            if (closeOpts?.idleReap) {
              recordSandboxReap(opts.ledger.sandboxId, finalState, closeOpts.idleReap)
            } else {
              recordSandboxState(opts.ledger.sandboxId, finalState)
            }
          }
        }
      }
    },
  }

  if (!opts.detachable) return proxy

  const record = (): SandboxDetachRecord => ({ remoteSessionId, transcriptSeq: transcriptCursor })
  return {
    ...proxy,
    detachRecord: () => (closed && !detached ? undefined : record()),
    detach(): SandboxDetachRecord | undefined {
      if (closed && !detached) return undefined
      if (!detached) {
        detached = true
        stopTimers()
        activeController?.abort()
        // Drop the MCP connection only — the box session and the box stay up.
        void host.close?.().catch(() => undefined)
      }
      return record()
    },
    async extendDetachedLifetime(): Promise<void> {
      try {
        await host.extendTimeout?.(DETACHED_BOX_LIFETIME_MS)
      } catch {
        // best-effort: the box keeps whatever lifetime it already had
      }
    },
    async probeReattach(): Promise<SandboxReattachProbe> {
      const probe = await probeBoxSession(host.mcpUrl, remoteSessionId, transcriptCursor)
      lastProbeState = probe.state
      return probe
    },
    async *resumeTurn(): AsyncIterable<AgentStreamEvent> {
      const isFirstTurn = turnsSent === 0
      turnsSent++
      // Only a re-attach to a BUSY box is live work; an idle replay is backlog.
      const live = lastProbeState === "busy"
      if (live) activeTurns++
      try {
        yield* consumeTurn(
          isFirstTurn,
          await host.currentEventsCursor(),
          live ? undefined : REPLAY_QUIET_END_MS,
        )
      } finally {
        if (live) activeTurns--
      }
    },
  }
}
