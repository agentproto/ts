/**
 * Sessions registry — tracks long-lived child processes spawned by
 * the agentproto daemon (terminals, agent CLIs, custom commands).
 *
 * The registry lives in-memory for the daemon's lifetime; a recent
 * snapshot also persists to `~/.agentproto/sessions.json` so a fresh
 * daemon restart can show "you had these running before" instead of
 * losing all visibility on a crash.
 *
 * Each session owns:
 *   - identity: id, kind, workspace slug, command + args, started time
 *   - lifecycle: status (starting/running/exited/killed/error)
 *   - output:    last N lines (ring buffer) for instant attach + a
 *                Node EventEmitter for live streaming consumers
 *
 * Consumers:
 *   - HTTP routes (GET /sessions, /sessions/:id, /sessions/:id/stream,
 *     POST /sessions/:id/kill)
 *   - CLI `agentproto sessions` (TUI navigation + attach)
 *   - guilde-web Active tab (session cards + terminal viewer)
 */

import type { AcpMcpServer } from "@agentproto/acp"
import { spawn, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdirSync, writeFileSync, promises as fs, readFileSync } from "node:fs"
import { RESUME_STRATEGIES } from "./resume-strategies.js"
import { readCommandLogEntry, writeCommandLogEntry } from "./command-log.js"
import type { SessionEventBus, SessionAwaitingQuestion } from "./session-event-bus.js"
import {
  composeSessionObservers,
  filterSessionObserver,
  type SessionObserver,
} from "./session-observer.js"
import { formatToolCall, formatToolResult } from "./tool-presenter.js"
import { createTranscriptWriter } from "./transcript-writer.js"
import { createTerminalTranscriptWriter } from "./terminal-transcript-writer.js"
import { deriveSessionUsage, type SessionUsage } from "./usage.js"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"

/**
 * Minimal shape we need from a driver-agent-cli session — kept as a
 * structural type so the runtime package doesn't take a hard
 * dependency on @agentproto/driver-agent-cli (the http-server route
 * imports it and passes the constructed session in).
 */
export interface AgentSessionLike {
  sessionId: string
  /** OS-level process id of the spawned child, when the driver owns a
   *  real subprocess. Mirrored onto `SessionDescriptor.pid` at
   *  `spawnAgent` time so `processAlive` can be computed without
   *  adapter-specific forensics. Undefined for drivers that don't
   *  expose a process (e.g. a future non-subprocess transport). */
  pid?: number
  send(message: unknown): AsyncIterable<AgentStreamEvent>
  cancel(): Promise<void>
  close(): Promise<void>
}

/**
 * Minimal PTY surface — structurally compatible with
 * @agentproto/acp/tunnel's PtyProcess (node-pty's IPty wrapper). The
 * runtime declares its own so this package stays native-free; the
 * cli's pty-factory util constructs values that satisfy both.
 */
export interface PtyProcess {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(handler: (data: string) => void): void
  onExit(handler: (event: { exitCode: number; signal?: number }) => void): void
}

export interface PtyFactoryOptions {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  cols: number
  rows: number
}

export type PtyFactory = (opts: PtyFactoryOptions) => PtyProcess

export interface AgentStreamEvent {
  kind: string
  text?: string
  /** Correlates a "tool-call" with its later "tool-result" (and an
   *  "agent-prompt" with the permission it's asking about) — see
   *  @agentproto/acp's `StreamEvent`. */
  toolCallId?: string
  toolName?: string
  /** Tool-call input, e.g. an ACP `tool_call`'s `arguments` — see @agentproto/acp's `StreamEvent`. */
  arguments?: unknown
  /** Tool-call output, e.g. an ACP `tool_call_update`'s `result` — see @agentproto/acp's `StreamEvent`. */
  result?: unknown
  isError?: boolean
  reason?: string
  error?: { message: string; code?: number; data?: unknown }
  /** Structured options offered by an "agent-prompt" event (e.g. an ACP
   *  `requestPermission` callback surfaced as a clarifying question rather
   *  than auto-answered). Typed `unknown` — like `@agentproto/acp`'s own
   *  `StreamEvent["options"]` — so this structural type stays assignable
   *  from any driver's runtime session without a hard dependency on its
   *  exact option shape (`{optionId,name,kind}` for ACP, or whatever a
   *  future driver reports); `normalizeAgentPromptOptions` narrows it
   *  defensively at the one place it's consumed. */
  options?: unknown
  /** "plan" event entries — see @agentproto/acp's `StreamEvent`'s `plan` kind. */
  entries?: Array<{ content: string; priority: string; status: string }>
  /** "usage_update" context-window size (tokens). */
  size?: number
  /** "usage_update" tokens currently in context. */
  used?: number
  /** "usage_update" cumulative session cost, when the adapter reports one. */
  cost?: { amount: number; currency: string }
  /** "usage_update" cumulative input/output token counts, when the adapter
   *  reports them (lets the daemon price a session whose adapter gives tokens
   *  but no `cost`). */
  tokensIn?: number
  tokensOut?: number
}

/**
 * Defensively narrow an "agent-prompt" event's `options` (typed `unknown`
 * — see `AgentStreamEvent.options`) into a flat label list. Accepts plain
 * strings, or objects exposing `label`/`name`/`id`/`optionId` (covers both
 * a hypothetical `{id,label}` shape and ACP's actual `{optionId,name,kind}`
 * `requestPermission` options) without assuming either driver-specific
 * shape at the type level.
 */
function normalizeAgentPromptOptions(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const labels = raw
    .map(o => {
      if (typeof o === "string") return o
      if (o && typeof o === "object") {
        const r = o as Record<string, unknown>
        const label = r.label ?? r.name ?? r.id ?? r.optionId
        if (typeof label === "string") return label
      }
      return undefined
    })
    .filter((s): s is string => typeof s === "string")
  return labels.length > 0 ? labels : undefined
}

/**
 * Classify what a tool call blocks the turn on, from its tool name alone.
 * Powers `SessionDescriptor.blockedOn`: "subagent" for an `agent_start`
 * (the turn is waiting on a spawned child agent), "command" for shell /
 * terminal execution tools. Anything else — including fast local tools —
 * returns undefined and leaves the descriptor untouched. Matching is
 * intentionally loose on the command side (bash/terminal/command
 * substrings) so adapter-native tool names (e.g. claude-code's "Bash")
 * classify without a per-adapter table.
 */
function classifyBlockedOn(toolName?: string): "subagent" | "command" | undefined {
  if (!toolName) return undefined
  const n = toolName.toLowerCase()
  if (n === "agent_start") return "subagent"
  if (/^(command_execute|terminal_start)$|bash|terminal|command/.test(n)) return "command"
  return undefined
}

/**
 * True when a thrown value represents a turn ABORT rather than a genuine
 * error — a cancelled/killed turn surfaces as a DOMException-style
 * `AbortError` (`name`) or Node's `ABORT_ERR` (`code`). Lets the turn
 * finalizer synthesize a `turn-end` tagged `"aborted"` instead of
 * mislabelling a deliberate cancel as a turn error. Kill-driven aborts are
 * additionally caught by inspecting the descriptor status at the call site.
 */
function isAbortError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false
  const name = "name" in err ? err.name : undefined
  const code = "code" in err ? err.code : undefined
  return name === "AbortError" || code === "ABORT_ERR"
}

export const SESSIONS_FILE_PATH = (): string =>
  resolve(homedir(), ".agentproto", "sessions.json")

export type SessionKind = "terminal" | "agent-cli" | "command" | "browser"
export type SessionStatus =
  | "starting"
  | "running"
  | "exited"
  | "killed"
  | "error"

/**
 * Thrown by `sendPrompt` / `enqueuePrompt` when the target agent-cli
 * session is dead (status exited/killed/error) and either isn't
 * resumable or its resume attempt already failed. Carries the actual
 * `status` so ingress layers (MCP `agent_prompt`, HTTP
 * `POST /sessions/:id/prompt`) can report a truthful, structured error
 * instead of the prompt silently going nowhere — see the "prompt to a
 * dead session" bug this type fixes at its throw site in
 * `validateAgentTurn`.
 */
export class SessionNotAliveError extends Error {
  readonly sessionId: string
  readonly status: SessionStatus
  constructor(sessionId: string, status: SessionStatus, caller: string) {
    super(`${caller}: session "${sessionId}" is not alive (status=${status})`)
    this.name = "SessionNotAliveError"
    this.sessionId = sessionId
    this.status = status
  }
}

export interface SessionDescriptor {
  id: string
  kind: SessionKind
  workspaceSlug: string
  /** What was actually run — quoted joined for display purposes
   *  (`bash -lc "claude --resume xyz"`). */
  command: string
  pid: number | null
  status: SessionStatus
  startedAt: string
  endedAt?: string
  exitCode?: number
  /** Last time anything was written to stdout/stderr. Lets the UI
   *  spot stuck sessions ("running for 2h, last output 12min ago"). */
  lastOutputAt?: string
  /** Last time ANY adapter-process activity was observed — ACP
   *  JSON-RPC traffic, protocol-level events, not just ring-buffer
   *  output lines. Stays current during long tool-call chains where
   *  `lastOutputAt` goes stale. Updated on incoming session/update
   *  notifications AND on outbound RPC calls. ISO 8601. */
  lastActivityAt?: string
  /** Whether the underlying OS process is still alive. Computed via
   *  `process.kill(pid, 0)` at read time (list()/get()) — cheap,
   *  zero-overhead, standard POSIX check. Absent when `pid` is null
   *  (no process to check). Never persisted — recomputed fresh on
   *  every read since it's a live OS query, stale the instant it's
   *  written to disk. */
  processAlive?: boolean
  /** Free-text label the spawner can attach (e.g. conversation id,
   *  operator name) so the UI can group/filter. */
  label?: string
  /** True when the session was spawned under a real PTY (node-pty)
   *  instead of `child_process.spawn`. PTY sessions carry raw ANSI
   *  bytes (alt-screen, key bindings, colors); attach goes through
   *  WS /sessions/:id/pty rather than SSE /sessions/:id/stream. */
  pty?: boolean
  /** User-friendly slug supplied at spawn time. Optional; when set,
   *  attach/stop/kill commands accept it as an alias for the id. */
  name?: string
  /** Argv that was spawned. Persisted so `agentproto sessions restart`
   *  can clone the original shape without re-tokenizing the display
   *  `command` string. Empty for agent-cli sessions (we record
   *  `adapterSlug` separately). */
  argv?: readonly string[]
  /** Working directory the session was spawned in. Cloned by restart. */
  cwd?: string
  /** Adapter slug for agent-cli sessions — restart uses this with
   *  `/sessions/agent` to spin up a fresh ACP runtime. Undefined for
   *  pty/command kinds. */
  adapterSlug?: string
  /** The model the session was requested to run (echoed back at spawn). */
  model?: string
  /** Cumulative estimated USD cost of the session — best-effort, refreshed
   *  on each turn-end from the adapter's usage reader (e.g. hermes reads its
   *  state.db). Absent for adapters with no usage source. */
  costUsd?: number
  /** Cumulative input / output token counts (same source + cadence as costUsd). */
  tokensIn?: number
  tokensOut?: number
  /** Context-window size + tokens-in-context from the latest `usage_update`
   *  event (ACP adapters that report a context window). Refreshed live as
   *  usage_update events arrive, not just at turn-end. */
  contextSize?: number
  contextUsed?: number
  /** Where `costUsd` came from — `"adapter"` (adapter's own reader or a
   *  usage_update cost block), `"computed"` (tokens × in-repo catalog price),
   *  `"no-pricing"` (tokens present but the model isn't in the catalog — cost
   *  deliberately left undefined), or `"none"`. Stamped at each turn-end. */
  usageSource?: import("./usage.js").UsageSource
  /** ACP-level session id (the adapter's own handle — claude-code's
   *  conversation id, hermes' chat id, …). Set at spawnAgent time
   *  from `agentSession.sessionId`. Survives across daemon restarts
   *  via sessions.json so `restart` can pass it as `resumeSessionId`
   *  and reattach to the prior conversation history. */
  adapterSessionId?: string
  /** MCP servers mounted into the agent's session at spawn time
   *  (orchestrator WP1). Persisted so the resume/re-spawn path can
   *  re-mount the same host-chosen toolset instead of resuming a
   *  capability-stripped agent. The current `AcpMcpServer` shape is
   *  `{ name, transport, ref? }` — a reference, NOT inline credentials
   *  — so this carries no secrets today. Should the shape ever grow
   *  headers/tokens, NEVER log this field's contents. */
  mcpServers?: AcpMcpServer[]
  /** Provider-specific resume hints sniffed from the session's
   *  output. claude-code prints `claude --resume <uuid>` on exit;
   *  we capture that uuid as `claudeResumeId`. On `restart`, when a
   *  hint is present, agentproto prefers a PTY spawn with the
   *  provider's native resume command (`claude --resume <id>`) over
   *  the ACP-level resume — works wherever the provider persisted
   *  the session, not just when the ACP wrapper did.
   *
   *  Keys are adapter-specific so future adapters can add their own
   *  ("hermesResumeId", etc.) without changing this type. */
  resumeMetadata?: Record<string, string>
  /** Set by the orchestration layer when the agent emits an
   *  "awaiting-input" turn-end. Cleared on the next turn start.
   *  Used by `session_monitor` to fast-return without subscribing. */
  awaitingInput?: boolean
  /**
   * Structured detail on WHY the session is awaiting input, when it can be
   * determined — lets an orchestrator distinguish "blocked on a real
   * question" from "just finished a turn" without re-reading raw output.
   * `source: "structured"` comes from a driver-reported ACP-style prompt
   * (`AgentStreamEvent.options`, e.g. a tool permission request);
   * `source: "heuristic"` is a best-effort guess from the tail of the
   * transcript (trailing "?" + an optional enumerated option list) for
   * drivers that don't report structured prompts. Cleared alongside
   * `awaitingInput` on the next turn start. */
  awaitingQuestion?: SessionAwaitingQuestion
  /** Count of turns that have fully completed (turn-end emitted) on this
   *  session. Lets `session_monitor` fast-return for a session that already
   *  finished its turn before the wait subscribed — a fast turn that ends
   *  in "completed" (not "awaiting-input") leaves no other persisted
   *  signal (status stays "running", busy clears). 0 = never ran a turn,
   *  so a freshly-spawned idle session is NOT mistaken for done. */
  turnsCompleted?: number
  /** True while a turn is actively running (mirror of the internal
   *  runtime `busy` flag). Lets `session_monitor` distinguish "idle after a
   *  finished turn" from "mid-turn" so it doesn't fast-return a stale
   *  turn-end while the NEXT turn is still generating. */
  busy?: boolean
  /** What the in-flight turn is currently blocked on, when classifiable
   *  from the pending tool call: a spawned sub-agent (`agent_start`) or a
   *  shell/terminal command. Deliberately NO "user" variant — waiting on
   *  the user is already covered by `awaitingInput`/`awaitingQuestion`.
   *  Set on tool-call, cleared on the MATCHING tool-result (guarded by
   *  `pendingToolCallId`), at turn start, and in the turn's finally. */
  blockedOn?: "subagent" | "command"
  /** toolCallId of the tool-call that set `blockedOn`. A tool-result only
   *  clears `blockedOn` when its toolCallId matches — so a nested or
   *  interleaved tool finishing first can't clear the flag early. */
  pendingToolCallId?: string
  /** Session id of the orchestrator that spawned this session, set when
   *  the spawn arrived via the scoped orchestrator sub-gateway (the
   *  token carried the spawner's identity). Absent for direct `/mcp`
   *  spawns (the root operator). Powers the subtree scoping of
   *  list/kill and the per-parent child quota (orchestrator WP4).
   *  Persisted so the tree survives a daemon restart. */
  parentSessionId?: string
  /** Recursion depth in the orchestrator tree: a direct (root) spawn is
   *  depth 0; a session spawned by a depth-d orchestrator is d+1. Used
   *  by the depth-cap guard. Persisted alongside `parentSessionId`.
   *  Treated as 0 when absent (legacy rows / direct spawns that predate
   *  WP4). */
  depth?: number
  /** Id of the most recently-completed `kind: "command"` session spawned
   *  with the same `cwd`, found at spawn time — see `recordCommand` and
   *  `findPriorCommandSessionId`. Deliberately a REFERENCE, not copied
   *  content: a new session's own ring buffer / structured transcript
   *  never gets a prior command_execute's stdout/stderr spliced in, it
   *  just gets told where to look (`command_log_tail({sessionId})` or
   *  `agent_export`/`command_list` resolve the id into the full record).
   *  Set on `spawnAgent`/`spawnPty` when the registry already has a
   *  matching command session; absent otherwise (including for legacy
   *  rows persisted before this field existed). */
  priorCommandSessionId?: string
  // ── Browser-session fields (kind="browser") ──────────────────────────────
  /** Adapter id that drives this session (e.g. "camofox", "bureau"). */
  browserAdapterId?: string
  /** Port the browser service listens on. */
  browserPort?: number
  /** Base URL of the browser service (e.g. "http://127.0.0.1:9377"). */
  browserBaseUrl?: string
  /** Execution location — "local" (default) or "cloud". */
  browserLocation?: "local" | "cloud"
}

interface SessionRuntime {
  desc: SessionDescriptor
  /** Set when the session is a raw spawn (`kind: "command"|"terminal"`).
   *  Agent sessions don't expose the underlying process — the
   *  driver-agent-cli runtime owns it. */
  child?: ChildProcess
  /** Set when the session is an agent-cli (multi-turn). The registry
   *  keeps it alive across turns; sendPrompt(id, prompt) re-uses it. */
  agentSession?: AgentSessionLike
  /** Adapter slug — only set for agent sessions, helps the UI render
   *  "claude-code" / "hermes" badges. */
  adapterSlug?: string
  /** Set when the session is a PTY (spawnPty). Bytes flow through
   *  pty.onData → recentBytes ring + emitter "data" event. */
  pty?: PtyProcess
  /** Per-subscriber size requests for the PTY. Min cols/rows
   *  across the live set is what we actually call pty.resize with
   *  (mirrors tmux's "smallest attached client wins" rule). */
  ptySubscribers?: Map<number, { cols: number; rows: number }>
  /** Ring buffer of recent stdout+stderr lines. Capped so a runaway
   *  child can't blow the daemon's heap. */
  recentLines: string[]
  /** Ring buffer of recent PTY bytes for replay-on-attach. Total
   *  size capped at RECENT_BYTES_CAP — oldest chunks dropped first. */
  recentBytes: Buffer[]
  recentBytesSize: number
  emitter: EventEmitter
  /** True while a turn is in flight. POST /sessions/:id/prompt rejects
   *  with 409 when busy — the agent can only handle one turn at a
   *  time per session. */
  busy: boolean
  /** Buffer for partial text-delta fragments — agent text events
   *  arrive as chunks, we coalesce them across deltas and split on
   *  newlines so each line lands as a discrete ring-buffer entry. */
  textBuf: string
  /** Same as textBuf but for `thought` events. Some agents (hermes)
   *  stream chain-of-thought as one delta per token, which made the
   *  ring buffer unreadable when each token got its own
   *  `[thought]` line — coalesce the same way text-delta does. */
  thoughtBuf: string
  /** In-flight resume promise. Deduplicates concurrent prompt
   *  attempts on a dead agent session — only one resume call hits
   *  the adapter, the rest await this promise. Cleared once
   *  resolved (success or failure). */
  resumePromise?: Promise<void>
  /** Async stop callback for browser sessions (kind="browser").
   *  Called by kill() best-effort — the descriptor is already flipped
   *  to "killed" before this fires. */
  browserStop?: () => Promise<void>
  /** Guard: true once session:exited has been emitted to sessionEvents.
   *  Prevents duplicate emissions when both kill() and an OS exit event fire. */
  exitedEmitted?: boolean
  /** Per-session cost cap. When set, the turn-end finally block checks
   *  the accumulated costUsd against this ceiling and kills the session
   *  if exceeded. */
  maxCostUsd?: number
  /** Best-effort usage reader called after each turn. The adapter returns
   *  accumulated cost/token counts which are mirrored onto the descriptor. */
  readUsage?: () => Promise<{ costUsd?: number; tokensIn?: number; tokensOut?: number } | null>
  /** True once an authoritative cost has been observed from the adapter —
   *  either its `readUsage` returned a `costUsd`, or a `usage_update` carried
   *  a `cost` block. Drives the `"adapter"` vs `"computed"` source decision at
   *  turn-end. */
  adapterReportedCost?: boolean
}

const RECENT_LINES_CAP = 500
const RECENT_BYTES_CAP = 64 * 1024
const PERSIST_DEBOUNCE_MS = 1_500
/** Cap on the number of historical descriptors loaded from
 *  sessions.json at boot. Older entries (by startedAt) are dropped
 *  on overflow — newest history wins. Adjust upward if the file
 *  starts feeling sparse; downward if the dashboard takes too long
 *  to render. */
const HISTORY_CAP = 200

/** Bound on how long `enqueuePrompt({interrupt: true})` waits for a
 *  cancelled turn to actually settle (busy → false) before giving up.
 *  A well-behaved adapter settles within a few event-loop turns of
 *  `cancel()` resolving; this is a safety net against an adapter that
 *  never delivers the corresponding turn-end, not the normal path. */
const INTERRUPT_SETTLE_TIMEOUT_MS = 30_000

/** Compute `desc.processAlive` from `desc.pid` via the standard POSIX
 *  "signal 0" check — `process.kill(pid, 0)` throws `ESRCH` (or
 *  `EPERM`, treated as "exists but not ours") when the process is
 *  dead, and is a no-op (no actual signal delivered) when it succeeds.
 *  Mutates `desc` in place; called at read time (list()/get()) rather
 *  than persisted, since it's a live OS query that goes stale the
 *  instant it's written to disk. */
function stampProcessAlive(desc: SessionDescriptor): void {
  if (desc.pid === null || desc.pid === undefined) {
    delete desc.processAlive
    return
  }
  try {
    process.kill(desc.pid, 0)
    desc.processAlive = true
  } catch {
    desc.processAlive = false
  }
}

/** Find the most recently-completed `kind: "command"` session whose `cwd`
 *  matches, for stamping `priorCommandSessionId` on a freshly spawned
 *  agent-cli/PTY session in the same workspace. Scans the in-memory
 *  registry (not the filesystem) — that's the same source of truth
 *  `command_list`/`session_list({kind:"command"})` themselves read from,
 *  including sessions restored from sessions.json at boot. A pure map
 *  scan over what's typically a handful of entries; no I/O, so nothing to
 *  fail here the way a filesystem lookup could. */
function findPriorCommandSessionId(
  liveSessions: Map<string, SessionRuntime>,
  cwd: string,
): string | undefined {
  let best: SessionRuntime | undefined
  for (const rt of liveSessions.values()) {
    if (rt.desc.kind !== "command" || rt.desc.cwd !== cwd) continue
    const bestTs = best ? (best.desc.endedAt ?? best.desc.startedAt) : undefined
    const candidateTs = rt.desc.endedAt ?? rt.desc.startedAt
    if (!best || candidateTs > bestTs!) best = rt
  }
  return best?.desc.id
}

/** Strip CSI / SGR ANSI sequences so resume-pattern matching works
 *  on dim/coloured output. Liberal regex covering most cases — we
 *  don't need byte-perfect parsing here. */
function stripAnsiCodes(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
}

/** Lines the ring buffer itself injects (turn separators, [tool] /
 *  [thought] / [awaiting input] markers) — never real transcript content,
 *  so the heuristic below skips them when looking for a trailing question. */
const SYNTHETIC_LINE = /^(?:──|\[)/

const OPTION_LINE_PATTERN = /^(?:[-*•]|\d+[.)]|[a-zA-Z][.)])\s+(.+)$/

/** Best-effort fallback for drivers that never report a structured
 *  "agent-prompt" (i.e. every currently-supported adapter — none emits
 *  ACP's `requestPermission` as a surfaced clarifying question today, they
 *  auto-answer it). A clarifying question's shape in a transcript is the
 *  question line followed by its enumerated options ("1. yes", "- retry",
 *  "a) skip", ...), so this scans backwards from the end of the transcript
 *  collecting a trailing run of option-shaped lines, then checks whether
 *  the line just before that run ends in "?". Always tagged
 *  `source: "heuristic"` so callers know this is a guess, not an
 *  authoritative signal. */
function deriveHeuristicQuestion(
  recentLines: string[],
): SessionAwaitingQuestion | undefined {
  const visible = recentLines
    .map(stripAnsiCodes)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !SYNTHETIC_LINE.test(l))
  if (visible.length === 0) return undefined

  const options: string[] = []
  let i = visible.length - 1
  while (i >= 0 && options.length < 6) {
    const m = OPTION_LINE_PATTERN.exec(visible[i]!)
    if (!m) break
    options.unshift(m[1]!.trim())
    i--
  }
  if (i < 0) return undefined
  const candidate = visible[i]!
  if (!candidate.endsWith("?")) return undefined
  return { text: candidate, ...(options.length > 0 ? { options } : {}), source: "heuristic" }
}

export interface SessionsRegistry {
  spawn(input: SpawnSessionInput): SessionDescriptor
  /** Adopt a ChildProcess that was spawned outside the registry —
   *  e.g. by the tunnel server when the host dispatches a spawn
   *  frame. The registry attaches its stdout/stderr listeners and
   *  tracks the descriptor so the child shows up in /sessions and
   *  the LocalDaemonSessionsCard. The caller keeps lifecycle
   *  ownership (kill / wait); this is purely for observability.
   *  Returns the descriptor for the registered session. */
  register(input: RegisterSessionInput): SessionDescriptor
  /** Register an already-built agent session (caller resolves the
   *  adapter + builds the runtime). Sets kind="agent-cli", consumes
   *  the optional initial prompt synchronously, returns the
   *  descriptor. The agent stays alive — call `sendPrompt(id, ...)`
   *  for follow-up turns until `kill(id)` closes it. */
  spawnAgent(input: SpawnAgentInput): SessionDescriptor
  /** Spawn a process under a real PTY (node-pty). Bytes flow through
   *  the registry's byte ring buffer + emitter; attach with
   *  `attachPty(id, ...)`. Throws when the registry was constructed
   *  without a `spawnPty` factory (node-pty optional dep missing). */
  spawnPty(input: SpawnPtyInput): SessionDescriptor
  /** Register a COMPLETED `command_execute` (or cron `kind:"command"`
   *  action) invocation as its own `kind: "command"` session. Unlike
   *  `spawn`/`spawnAgent`/`spawnPty`, there's no live process to track —
   *  the command already ran to completion via `runCommand` before this
   *  is called — so the descriptor is minted already "finished"
   *  (status exited/error, startedAt backdated by `durationMs`,
   *  endedAt now) and its full result is written to that session's own
   *  `events.jsonl` (see command-log.ts), the same per-id path an
   *  agent-cli session's structured transcript uses. Synchronous: the
   *  descriptor (and its id) is available immediately, the JSONL write
   *  itself is fire-and-forget internally. */
  recordCommand(input: RecordCommandInput): SessionDescriptor
  /** Read back a `kind:"command"` session's full logged result (the
   *  `CommandLogEntry` `recordCommand` wrote). Resolves to null when the
   *  session isn't a command session or has no recorded entry. Routed
   *  through the registry (rather than callers importing
   *  `readCommandLogEntry` directly) so the read always targets the same
   *  base directory `recordCommand` wrote to — that dir is test-overridable
   *  (`transcriptDir`) and callers outside sessions.ts have no other way
   *  to know it. */
  readCommandLog(sessionId: string): Promise<import("./command-log.js").CommandLogEntry | null>
  /** Register an already-running browser service adapter as a tracked
   *  session (kind="browser"). Idempotent by identity — each call
   *  mints a fresh session id. The `stop` callback is invoked by
   *  `kill()` best-effort. */
  registerBrowser(input: RegisterBrowserInput): SessionDescriptor
  /** Send a follow-up turn to a live agent session. Throws when the
   *  session is missing, not an agent-cli kind, dead (exited/killed/
   *  error and unresumable — `SessionNotAliveError`), or busy
   *  (mid-turn). The events stream into the existing ring buffer +
   *  line emitter so /stream consumers see them as they arrive. */
  sendPrompt(id: string, message: unknown): Promise<void>
  /** Fire-and-forget variant of `sendPrompt` for the TURN ITSELF only.
   *  Admission (resume attempt + the missing/wrong-kind/dead/busy
   *  checks `sendPrompt` throws) is AWAITED before this resolves, so a
   *  dead or busy session rejects instead of silently reporting
   *  success — only resolves once the turn has actually started.
   *  Errors during the turn's own execution (network drop, child died
   *  mid-turn) are pushed into the ring buffer as `[error]` lines so
   *  `/stream` subscribers see them. Used by the web UI's chat input
   *  and MCP `agent_prompt`, where a long turn would otherwise freeze
   *  the caller.
   *
   *  `opts.interrupt` lets a caller redirect a mid-turn session instead
   *  of hitting the busy rejection: the in-flight turn is cancelled
   *  (`agentSession.cancel()`), admission waits for that turn to
   *  actually settle (busy flips false — no fixed sleep), then the new
   *  prompt is admitted + fired on the SAME live session. Ignored
   *  (identical to the default) when the session is idle. Omitted or
   *  `false` reproduces today's mid-turn rejection byte-for-byte. */
  enqueuePrompt(
    id: string,
    message: unknown,
    opts?: { interrupt?: boolean }
  ): Promise<void>
  /** Stamp `lastActivityAt` on a live agent-cli session's descriptor
   *  and schedule a debounced persist. Called from the `onActivity`
   *  callback threaded down through the driver → ACP client, which
   *  fires on ANY adapter-process traffic (not just ring-buffer
   *  output) — see `SessionDescriptor.lastActivityAt`. No-op when the
   *  id is unknown (session already forgotten). */
  pulseActivity(id: string): void
  list(): SessionDescriptor[]
  get(id: string): SessionDescriptor | undefined
  /** Subscribe to a session's output. Returns an unsubscribe fn.
   *  Initial backfill: synchronously invokes `onLine` once for each
   *  line currently in the ring buffer so attaches show context. */
  attach(
    id: string,
    onLine: (line: string, stream: "stdout" | "stderr") => void
  ): (() => void) | null
  /** Subscribe to a PTY session's byte stream. Returns a control
   *  handle (write/resize/detach) and null when the session is
   *  missing or not a PTY kind. Replays the ring buffer
   *  synchronously before live frames start. Initial `cols`/`rows`
   *  are required so the registry can compute min-size across
   *  subscribers; recompute on every `resize` call. */
  attachPty(
    id: string,
    initial: { cols: number; rows: number },
    onData: (chunk: Buffer) => void,
    onExit: (event: { exitCode: number; signal?: number }) => void
  ): {
    write(data: string): void
    resize(cols: number, rows: number): void
    detach(): void
  } | null
  /** Find a session by exact id OR exact name match. Returns the
   *  descriptor or undefined. Used by HTTP/MCP routes so callers
   *  can refer to "claude-main" instead of "sess_a3f8c1b2". */
  findByIdOrName(query: string): SessionDescriptor | undefined
  /** Write a chunk of text to a PTY session's stdin. Returns true
   *  on success, false when the session is missing or not a PTY.
   *  Single-shot variant of attachPty().write — useful for MCP
   *  tools that drive a session through tool calls. */
  writeTerminalInput(id: string, data: string): boolean
  /** Snapshot the recent PTY byte buffer as one Buffer. Newest
   *  bytes at the end; `lastBytes` caps the returned size from the
   *  tail. Returns null when the session is missing or not a PTY. */
  readTerminalOutput(id: string, lastBytes?: number): Buffer | null
  kill(id: string, signal?: NodeJS.Signals): boolean
  /** Stop tracking a session (after it exited and the user clicked
   *  "clear"). Doesn't kill — use `kill` first. */
  forget(id: string): boolean
  /** Stop persisting + close all sessions. Killed children are not
   *  awaited — the daemon shutdown loop handles process tree teardown. */
  shutdown(): void
}

export interface RegisterBrowserInput {
  /** Adapter id (e.g. "camofox", "bureau", "chromium"). */
  adapterId: string
  /** Port the browser service listens on. */
  port: number
  /** Base URL of the browser service (e.g. "http://127.0.0.1:9377"). */
  baseUrl: string
  /** Execution location — "local" (default) or "cloud". Included in the
   *  dedup key so a cloud call never returns a pre-existing local session. */
  location?: "local" | "cloud"
  /** PID of the service process — undefined when managed by launchd/systemd. */
  pid?: number
  /** True when the service was already healthy before this call (idempotent start). */
  wasAlreadyRunning: boolean
  /** Initial lifecycle status. "running" when the service is confirmed
   *  healthy; "starting" when a non-blocking cold start returned before the
   *  service finished converging (health-wait continues in the background and
   *  `browser_status` / `list_browsers` flip it to running once up).
   *  Defaults to "running" when omitted. */
  status?: Extract<SessionStatus, "running" | "starting">
  /** Async shutdown callback — called by kill() best-effort. */
  stop: () => Promise<void>
  label?: string
}

export interface RegisterSessionInput {
  /** Pre-existing child process to adopt (e.g. from a tunnel spawn). */
  child: ChildProcess
  /** Stable id — typically the tunnel's execId so callers cross-ref. */
  id: string
  workspaceSlug: string
  /** Display label for the descriptor's `command` field. */
  command: string
  kind?: SessionKind
  label?: string
}

export interface SpawnAgentInput {
  workspaceSlug: string
  cwd: string
  /** Driver-built session ready to receive turns. Caller resolves
   *  the adapter, calls createAgentCliRuntime(handle).start({cwd}),
   *  and hands the result here. */
  agentSession: AgentSessionLike
  /** Adapter slug for the descriptor (display only). */
  adapterSlug: string
  /** Optional initial prompt to dispatch immediately. The promise
   *  the registry returns resolves AFTER the spawn — the prompt
   *  runs in the background, projecting events into the ring
   *  buffer. Skip to spawn idle. */
  initialPrompt?: string
  label?: string
  /** Pretty command for the descriptor (display only). */
  commandPreview?: string
  /** MCP servers mounted at spawn time. Persisted on the descriptor so
   *  the resume/re-spawn path can re-mount the same toolset (orchestrator
   *  WP1). */
  mcpServers?: AcpMcpServer[]
  /** Spawning orchestrator's session id — set when the spawn arrived
   *  through the scoped sub-gateway (orchestrator WP4). Recorded on the
   *  descriptor for subtree scoping + quota accounting. */
  parentSessionId?: string
  /** Recursion depth for the new session (orchestrator WP4). Defaults to
   *  0 when omitted (direct/root spawn). */
  depth?: number
  /** Requested model id — recorded on the descriptor for display + echo. */
  model?: string
  /** Hard ceiling on cumulative session cost (USD). When set and the
   *  adapter's usage reader reports a higher cost at a turn-end, the session
   *  is stopped (best-effort, turn-granular — caps continuation, can't abort
   *  a turn mid-flight). */
  maxCostUsd?: number
  /** Best-effort usage reader, called on each turn-end to refresh the
   *  cost/token fields on the descriptor. Adapter-specific (e.g. hermes
   *  reads its state.db keyed by the adapter session id). Omit for adapters
   *  with no usage source. */
  readUsage?: () => Promise<{ costUsd?: number; tokensIn?: number; tokensOut?: number } | null>
  /** Opt this session into Langfuse tracing (prompt/completion + tool spans +
   *  tokens/cost). Effective opt-in is `trace ?? opts.langfuseTracingDefault ?? false`. */
  trace?: boolean
}

export interface SpawnSessionInput {
  kind: SessionKind
  workspaceSlug: string
  /** Path of the workspace root (for the child's cwd). The registry
   *  doesn't validate it against the workspaces config — caller has
   *  already resolved this. */
  cwd: string
  /** Argv. First element is the binary; rest are passed verbatim. */
  argv: string[]
  /** Extra env on top of the daemon's process.env. */
  env?: Record<string, string>
  /** Optional pre-set id (lets the spawner reference the session
   *  before the spawn returns — useful for telemetry). */
  id?: string
  label?: string
  /** Keep the child's stdin open (default: closed). Most spawned
   *  agents are non-interactive and emit a warning when stdin is a
   *  pipe with no writer (claude-code prints "no stdin data
   *  received in 3s, proceeding without it"). Closing stdin lets
   *  them skip the wait. PTY/terminal kinds that genuinely need
   *  bidirectional IO should opt in via `keepStdin: true` and the
   *  caller is then responsible for writing to `child.stdin`. */
  keepStdin?: boolean
}

export interface SpawnPtyInput {
  workspaceSlug: string
  cwd: string
  argv: string[]
  /** Initial PTY dimensions. The registry uses min(cols, rows) across
   *  active subscribers thereafter — these are the seed values used
   *  before anyone attaches. */
  cols: number
  rows: number
  /** Extra env on top of process.env. TERM/LANG/PATH are forced by
   *  the factory layer (node-pty.spawn options); don't try to clear
   *  them here. */
  env?: Record<string, string>
  /** User-friendly slug. Used by `findByIdOrName(query)`. Must not
   *  collide with an existing session's name. */
  name?: string
  label?: string
}

export interface RecordCommandInput {
  workspaceSlug: string
  /** Working directory the command actually ran in (post cwd-anchoring).
   *  Matched against a fresh session's cwd by `findPriorCommandSessionId`. */
  cwd: string
  command: string
  args: string[]
  /** Fields mirror `command-tools.ts`'s `ExecuteResult` — kept inline here
   *  (rather than importing that type) so sessions.ts has no dependency
   *  on command-tools.ts. */
  exitCode: number
  signal: string | null
  durationMs: number
  stdout: string
  stderr: string
  truncated?: boolean
  label?: string
}

/**
 * Hook the registry uses to rebuild a dead agent session on demand.
 * Invoked when a prompt arrives for an agent-cli session whose
 * `agentSession` was lost (typically daemon restart). Returns a fresh
 * `AgentSessionLike` bound to the same upstream conversation via
 * `resumeSessionId`, OR null if resume isn't possible (adapter gone,
 * upstream rejected). When null, the prompt path surfaces the same
 * "not an agent session" error as before — caller knows the row is a
 * ghost.
 *
 * The CLI wires this into the registry by passing in a closure that
 * calls `resolveAgentAdapter(slug)?.startSession({cwd, resumeSessionId})`,
 * which is the same path the gateway's POST /sessions/agent uses.
 */
export type AgentSessionResumer = (input: {
  adapterSlug: string
  cwd: string
  resumeSessionId: string
  /** MCP servers to re-mount on the resumed session — threaded from the
   *  descriptor's persisted `mcpServers` so the re-spawned agent keeps the
   *  same host-chosen toolset it had on the initial spawn (orchestrator
   *  WP1). Omitted for legacy rows spawned before this was persisted. */
  mcpServers?: AcpMcpServer[]
  /** Forwarded to the re-spawned adapter's `startSession({ onActivity })`
   *  so the resumed session keeps pulsing `lastActivityAt` the same way
   *  the original spawn did. */
  onActivity?: () => void
}) => Promise<AgentSessionLike | null>

export function createSessionsRegistry(opts?: {
  /** Override the persistence path — tests pin a tmpdir. */
  persistPath?: string
  /** Disable persistence entirely. */
  persist?: boolean
  /** PTY factory (node-pty wrapper). When omitted, `spawnPty()`
   *  throws — the daemon advertises PTY support only when the cli
   *  layer resolved node-pty successfully. */
  spawnPty?: PtyFactory
  /** Hook called when a prompt arrives for an agent-cli session whose
   *  agentSession binding is gone (daemon restart). When provided,
   *  the registry transparently resumes the session via the adapter's
   *  resumeSessionId before dispatching the turn. When omitted,
   *  killed agent-cli sessions surface the legacy "not an agent
   *  session" error and the user must spawn fresh. */
  resumeAgent?: AgentSessionResumer
  /** When provided, the registry translates internal lifecycle transitions
   *  (turn-end, awaiting-input, exit) into SessionEvents on this bus. */
  sessionEvents?: SessionEventBus
  /** Override the structured-transcript base directory. Defaults to a
   *  `sessions` sibling of `persistPath` (`~/.agentproto/sessions` in
   *  production) — tests that already pin `persistPath` to a tmpdir get
   *  transcript isolation for free without also having to pass this. */
  transcriptDir?: string
  /** Shared, opt-in Langfuse session observer. Built once in the bootstrap
   *  from eval-reporter creds. Events only reach it for sessions in the
   *  registry's traced-session set — see `langfuseTracingDefault`. */
  langfuseTracer?: SessionObserver
  /** Default per-session tracing opt-in when `SpawnAgentInput.trace` is
   *  omitted. Defaults to false (tracing off). */
  langfuseTracingDefault?: boolean
}): SessionsRegistry {
  const persistPath = opts?.persistPath ?? SESSIONS_FILE_PATH()
  const persist = opts?.persist ?? true
  const transcriptBaseDir = opts?.transcriptDir ?? join(dirname(persistPath), "sessions")
  const baseTranscriptWriter = createTranscriptWriter({ baseDir: transcriptBaseDir })
  // Sibling writer for PTY (`terminal`) sessions — same per-id directory,
  // a `terminal.jsonl` file instead of `events.jsonl` since raw bytes
  // (not structured StreamEvents) are what a PTY has to persist.
  const terminalTranscriptWriter = createTerminalTranscriptWriter({ baseDir: transcriptBaseDir })
  // The transcript writer is the first (today only) per-session observer. The
  // composite fans every prompt/event/usage/close call out to its members, so
  // additional observers (e.g. an opt-in Langfuse session tracer) attach here
  // without touching any of the turn-loop call sites below. With a single
  // member the behaviour is identical to calling the writer directly.
  const tracedSessions = new Set<string>()
  const extraObservers: readonly SessionObserver[] = opts?.langfuseTracer
    ? [filterSessionObserver(opts.langfuseTracer, (id) => tracedSessions.has(id))]
    : []
  const transcriptWriter: SessionObserver = composeSessionObservers([
    baseTranscriptWriter,
    ...extraObservers,
  ])
  const ptyFactory = opts?.spawnPty
  const resumeAgent = opts?.resumeAgent
  const sessionEvents = opts?.sessionEvents
  const sessions = new Map<string, SessionRuntime>()
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  // Monotonically-growing PTY-subscriber id. Detach is O(1) on
  // Map.delete(subId), so we never reuse — overflow at Number.MAX_-
  // SAFE_INTEGER would take ~285 years at 1M attaches/sec.
  let nextSubId = 1
  // Guards `shutdown()` from running twice — double-stop happens in
  // serve --interactive's Ctrl-C race; without this, the second
  // call writes an empty snapshot over the real one.
  let shutdownDone = false

  // ── boot-time history load ──
  // Read sessions.json synchronously at construction so the dashboard
  // shows historical sessions immediately on daemon restart. Anything
  // that was "running" or "starting" when the daemon last died gets
  // marked "killed" — we have no way to know if the orphan child
  // survived the daemon's exit, and pretending it's still alive would
  // make attach calls fail mysteriously.
  //
  // Historical entries are GHOSTS: descriptor only, no child / no
  // agentSession / no pty. Calls like kill(id) / attach(id) work on
  // them but degrade to no-ops (the underlying process is gone). The
  // session's `endedAt` is set to now when we infer a kill, so the
  // dashboard ages them from this boot rather than the daemon's last
  // life.
  if (persist) {
    loadHistorySnapshot(persistPath, sessions)
  }

  // Belt-and-suspenders: `process.on("exit")` runs even on uncaught
  // throws, terminal-close (SIGHUP), and any termination path that
  // bypassed the regular SIGINT/SIGTERM cleanup. The handler must be
  // sync (Node won't await async there); we already use sync IO in
  // `shutdown()` so this is safe. Idempotency guard inside shutdown
  // prevents a double-write when both this handler and the explicit
  // SIGINT path fire.
  const onProcessExit = (): void => {
    shutdownImpl()
  }
  if (persist) {
    process.on("exit", onProcessExit)
  }

  // Emit session:exited once per session, deduplicated via exitedEmitted flag.
  const emitExited = (rt: SessionRuntime): void => {
    if (!sessionEvents || rt.exitedEmitted) return
    rt.exitedEmitted = true
    sessionEvents.emit({
      type: "session:exited",
      sessionId: rt.desc.id,
      exitCode: rt.desc.exitCode,
      status: rt.desc.status as "exited" | "killed" | "error",
      label: rt.desc.label,
      ts: new Date().toISOString(),
    })
  }

  const schedulePersist = (): void => {
    if (!persist) return
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      void persistSnapshot()
    }, PERSIST_DEBOUNCE_MS)
  }

  const persistSnapshot = async (): Promise<void> => {
    try {
      const snapshot = {
        savedAt: new Date().toISOString(),
        // `processAlive` is a live OS query (see stampProcessAlive) —
        // strip it before writing so a restored descriptor is never
        // seen with a stale value before the next list()/get() call
        // recomputes it fresh.
        sessions: Array.from(sessions.values()).map(s => {
          const { processAlive: _processAlive, ...rest } = s.desc
          return rest
        }),
      }
      await fs.mkdir(dirname(persistPath), { recursive: true })
      await fs.writeFile(persistPath, JSON.stringify(snapshot, null, 2) + "\n")
    } catch (err) {
      // Persistence is best-effort — log only, never throw.
      console.warn(
        `[sessions] persist failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  const appendLine = (
    rt: SessionRuntime,
    line: string,
    stream: "stdout" | "stderr"
  ): void => {
    rt.recentLines.push(line)
    if (rt.recentLines.length > RECENT_LINES_CAP) {
      rt.recentLines.splice(0, rt.recentLines.length - RECENT_LINES_CAP)
    }
    rt.desc.lastOutputAt = new Date().toISOString()
    sniffResumeHints(rt, line)
    rt.emitter.emit("line", { line, stream })
  }

  /**
   * Provider-specific resume-hint sniffer. Looks up the adapter's
   * strategy in `RESUME_STRATEGIES` and runs its `outputHint` regex
   * against each agent-cli line. The captured id is recorded on the
   * descriptor so `agentproto sessions restart` can use it.
   *
   * ANSI-stripped before matching so dim/color codes don't break the
   * pattern. Adapters without a strategy entry (or without an
   * outputHint) are skipped — they fall back to ACP-level resume.
   */
  const sniffResumeHints = (rt: SessionRuntime, line: string): void => {
    if (rt.desc.kind !== "agent-cli") return
    const strategy = rt.desc.adapterSlug
      ? RESUME_STRATEGIES[rt.desc.adapterSlug]
      : undefined
    if (!strategy?.outputHint) return
    const plain = stripAnsiCodes(line)
    const m = plain.match(strategy.outputHint)
    if (m && m[1]) {
      rt.desc.resumeMetadata = {
        ...(rt.desc.resumeMetadata ?? {}),
        [strategy.storeAs]: m[1],
      }
      schedulePersist()
    }
  }

  /**
   * PTY byte ring buffer. Keeps the last ~64 KiB of raw bytes so a
   * fresh attacher sees the current screenful (alt-screen apps like
   * Claude TUI / vim repaint on next interaction but a snapshot is
   * still better than blank). Drops oldest chunks when over cap;
   * never splits within a chunk — Buffer arithmetic on UTF-8 mid-
   * sequence would corrupt multi-byte glyphs.
   */
  const appendBytes = (rt: SessionRuntime, chunk: Buffer): void => {
    // Durable copy BEFORE the RAM ring drops anything — same ordering
    // rule transcript-writer.ts follows for agent-cli StreamEvents.
    terminalTranscriptWriter.appendChunk(rt.desc.id, chunk)
    rt.recentBytes.push(chunk)
    rt.recentBytesSize += chunk.byteLength
    while (
      rt.recentBytesSize > RECENT_BYTES_CAP &&
      rt.recentBytes.length > 1
    ) {
      const dropped = rt.recentBytes.shift()
      if (dropped) rt.recentBytesSize -= dropped.byteLength
    }
    rt.desc.lastOutputAt = new Date().toISOString()
    rt.emitter.emit("data", chunk)
  }

  /**
   * Recompute the smallest cols/rows across the active subscriber
   * set and resize the PTY accordingly (tmux's "smallest attached
   * client wins" rule). No-op when the subscriber map is empty.
   */
  const reconcilePtySize = (rt: SessionRuntime): void => {
    if (!rt.pty || !rt.ptySubscribers || rt.ptySubscribers.size === 0) return
    let cols = Infinity
    let rows = Infinity
    for (const dim of rt.ptySubscribers.values()) {
      if (dim.cols < cols) cols = dim.cols
      if (dim.rows < rows) rows = dim.rows
    }
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
    try {
      rt.pty.resize(cols, rows)
    } catch {
      // pty may have exited between the emit and the resize — swallow.
    }
  }

  /**
   * Project ACP-style stream events into ring-buffer lines. Keeps
   * the line shape simple so the existing /stream SSE consumer
   * (and the xterm panel) just renders them as-is.
   */
  const projectEvent = (rt: SessionRuntime, evt: AgentStreamEvent): void => {
    switch (evt.kind) {
      case "text-delta":
        if (evt.text) {
          // text-delta is a stream of chunks — split on newlines so
          // each line lands in the ring buffer separately. Coalesce
          // a trailing fragment via rt.textBuf.
          const combined = rt.textBuf + evt.text
          const lines = combined.split(/\r?\n/)
          rt.textBuf = lines.pop() ?? ""
          for (const line of lines) appendLine(rt, line, "stdout")
        }
        break
      case "thought":
        if (evt.text) {
          // Same coalescing as text-delta — some adapters stream
          // chain-of-thought one token at a time, which would
          // otherwise produce ~100 [thought] lines per turn.
          const combined = rt.thoughtBuf + evt.text
          const lines = combined.split(/\r?\n/)
          rt.thoughtBuf = lines.pop() ?? ""
          for (const line of lines) {
            if (line.trim()) {
              appendLine(rt, `\x1b[2m[thought] ${line}\x1b[0m`, "stdout")
            }
          }
        }
        break
      case "tool-call": {
        // Surface what the turn is now blocked on (sub-agent / command)
        // when the tool name classifies. The toolCallId is remembered so
        // only the MATCHING result clears it (nested tools can't).
        const blocked = classifyBlockedOn(evt.toolName)
        if (blocked) {
          rt.desc.blockedOn = blocked
          rt.desc.pendingToolCallId = evt.toolCallId
        }
        appendLine(
          rt,
          `\x1b[36m[tool] ${formatToolCall(evt.toolName ?? "?", evt.arguments)}\x1b[0m`,
          "stdout"
        )
        break
      }
      case "tool-result": {
        if (rt.desc.blockedOn && evt.toolCallId === rt.desc.pendingToolCallId) {
          rt.desc.blockedOn = undefined
          rt.desc.pendingToolCallId = undefined
        }
        // Keep this to ONE line per result — some drivers stream huge
        // payloads (file dumps, search hits) and the ring buffer is a
        // fixed-size window, not a log store.
        const summary = formatToolResult(evt.toolName, evt.result, evt.isError ?? false)
        if (summary) {
          appendLine(
            rt,
            evt.isError
              ? `\x1b[31m[tool-error] ${summary}\x1b[0m`
              : `\x1b[2m[tool-result] ${summary}\x1b[0m`,
            evt.isError ? "stderr" : "stdout"
          )
        } else if (evt.isError) {
          appendLine(rt, `\x1b[31m[tool-error]\x1b[0m`, "stderr")
        }
        break
      }
      case "agent-prompt": {
        rt.desc.awaitingInput = true
        const options = normalizeAgentPromptOptions(evt.options)
        if (options) {
          rt.desc.awaitingQuestion = {
            text: evt.text ?? (evt.toolName ? `Allow "${evt.toolName}"?` : "Agent is requesting input."),
            options,
            source: "structured",
          }
        }
        appendLine(rt, `\x1b[33m[awaiting input]\x1b[0m`, "stdout")
        break
      }
      case "turn-end": {
        if (evt.reason === "awaiting-input") rt.desc.awaitingInput = true
        // Flush any buffered text/thought fragments as final lines.
        if (rt.thoughtBuf.trim()) {
          appendLine(
            rt,
            `\x1b[2m[thought] ${rt.thoughtBuf}\x1b[0m`,
            "stdout"
          )
        }
        rt.thoughtBuf = ""
        if (rt.textBuf) {
          appendLine(rt, rt.textBuf, "stdout")
          rt.textBuf = ""
        }
        appendLine(
          rt,
          `\x1b[2m── turn-end (${evt.reason ?? "completed"}) ──\x1b[0m`,
          "stdout"
        )
        break
      }
      case "error": {
        const code =
          typeof evt.error?.code === "number" ? ` (code ${evt.error.code})` : ""
        appendLine(
          rt,
          `\x1b[31m[error]${code} ${evt.error?.message ?? "unknown"}\x1b[0m`,
          "stderr"
        )
        // Project the child's stderr tail when define-agent-cli
        // attached it — otherwise the user sees only "Invalid
        // params" and has to dig into the daemon log for context.
        const data = evt.error?.data as
          | { stderr?: unknown }
          | null
          | undefined
        if (data && typeof data === "object" && typeof data.stderr === "string") {
          for (const line of data.stderr.split(/\r?\n/)) {
            if (line) appendLine(rt, `\x1b[2m  ${line}\x1b[0m`, "stderr")
          }
        }
        break
      }
      case "plan": {
        const entries = evt.entries ?? []
        const done = entries.filter(e => e.status === "completed").length
        appendLine(
          rt,
          `\x1b[35m[plan] ${done}/${entries.length} ${entries.map(e => e.content).join("; ")}\x1b[0m`,
          "stdout"
        )
        break
      }
      // "usage_update" is high-frequency telemetry (context size/cost) — the
      // ring buffer isn't the right place for it (cost is surfaced via
      // rt.desc.costUsd at turn-end); it still lands in events.jsonl via the
      // transcript writer tap point. We DO mirror its structured fields onto
      // the descriptor here so the latest context window + any adapter-
      // reported cost/tokens are available live to session_list / session_usage.
      case "usage_update": {
        if (typeof evt.size === "number" && evt.size > 0) rt.desc.contextSize = evt.size
        if (typeof evt.used === "number" && evt.used > 0) rt.desc.contextUsed = evt.used
        if (evt.cost) {
          rt.desc.costUsd = evt.cost.amount
          rt.adapterReportedCost = true
        }
        if (typeof evt.tokensIn === "number") rt.desc.tokensIn = evt.tokensIn
        if (typeof evt.tokensOut === "number") rt.desc.tokensOut = evt.tokensOut
        break
      }
    }
  }

  /**
   * Drive one agent turn. Sets busy=true, drains the event stream
   * into the ring buffer, clears busy on completion. Bumps the
   * descriptor status to "error" if the iteration throws (network
   * drop, child died mid-turn).
   */
  /**
   * Shared sync validation for sendPrompt + enqueuePrompt. Throws on
   * missing session / wrong kind / dead session / busy so both code
   * paths surface the exact same error messages — the only difference
   * is whether the caller awaits the turn.
   *
   * Must be called AFTER `maybeResumeAgent(rt)` has already been
   * awaited — a dead-but-resumable agent-cli session only regains
   * `rt.agentSession` there.
   *
   * Liveness is checked via `rt.desc.status`, NOT merely
   * `!rt.agentSession` — `kill()` flips status to "killed" but leaves
   * `rt.agentSession` referencing the now-closed session object (it
   * only calls `.close()`, it doesn't clear the field), so a
   * `!rt.agentSession` check alone would miss a live-killed session
   * and let `runAgentTurn` call `.send()` on a dead connection. Status
   * catches that case too, not just the daemon-restart/dead-and-
   * unresumable case where `agentSession` really is absent. Either way
   * this throws `SessionNotAliveError` (not a generic Error) so
   * ingress can report status/409 truthfully instead of the caller
   * getting back a lie like `{queued: true}`.
   */
  const validateAgentTurn = (id: string, caller: string): SessionRuntime => {
    const rt = sessions.get(id)
    if (!rt) throw new Error(`${caller}: no session "${id}"`)
    if (rt.desc.kind !== "agent-cli") {
      throw new Error(
        `${caller}: session "${id}" is not an agent session (kind=${rt.desc.kind})`
      )
    }
    const isAlive = rt.desc.status === "running" || rt.desc.status === "starting"
    if (!isAlive || !rt.agentSession) {
      throw new SessionNotAliveError(id, rt.desc.status, caller)
    }
    if (rt.busy) {
      throw new Error(
        `${caller}: session "${id}" is mid-turn — wait for it to finish or cancel`
      )
    }
    return rt
  }

  /**
   * Race-free wait for a mid-turn session to settle to idle: resolves
   * the instant `rt.busy` flips false (the same flag `validateAgentTurn`
   * reads), driven by the "busy" event `runAgentTurn`'s finally block
   * emits — never a fixed sleep. Resolves immediately if the turn is
   * already over by the time this is called. Rejects if the turn
   * hasn't settled within `INTERRUPT_SETTLE_TIMEOUT_MS` (a hung/buggy
   * adapter that never delivers a turn-end for the cancelled turn).
   */
  const waitForTurnSettled = (rt: SessionRuntime, id: string): Promise<void> => {
    if (!rt.busy) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const onBusy = (busy: boolean): void => {
        if (busy) return
        cleanup()
        resolve()
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        rt.emitter.off("busy", onBusy)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(
          new Error(
            `enqueuePrompt: session "${id}" did not settle after interrupt within ${INTERRUPT_SETTLE_TIMEOUT_MS}ms`
          )
        )
      }, INTERRUPT_SETTLE_TIMEOUT_MS)
      rt.emitter.on("busy", onBusy)
    })
  }

  /**
   * `enqueuePrompt({interrupt: true})`'s mid-turn arm: cancel the
   * in-flight turn via the session handle's `cancel()` (the CLI-side
   * equivalent of Ctrl-C — ACP `session/cancel`, or an adapter-specific
   * SIGINT for process/PTY-backed adapters), then await the turn
   * actually settling before returning. Does NOT run admission itself
   * — the caller still goes through `validateAgentTurn` afterward, now
   * finding the session idle.
   */
  const interruptInFlightTurn = async (
    rt: SessionRuntime,
    id: string
  ): Promise<void> => {
    const session = rt.agentSession
    if (!session) {
      // Invariant: `runAgentTurn` requires `agentSession` before it
      // ever sets `busy = true`, and nothing clears the field once set
      // (see the `validateAgentTurn` doc comment on `kill()`) — this
      // only fires if that invariant is ever violated.
      throw new Error(
        `enqueuePrompt: session "${id}" is mid-turn but has no live agent session to cancel`
      )
    }
    try {
      await session.cancel()
    } catch (err) {
      throw new Error(
        `enqueuePrompt: session "${id}" does not support interrupt — cancelling the in-flight turn failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
    await waitForTurnSettled(rt, id)
  }

  /**
   * Attempt to resume a dead agent-cli session by re-spawning the
   * adapter with the persisted `adapterSessionId`. The conversation
   * continues from where it left off — ACP's `resumeSessionId`
   * contract guarantees the adapter rehydrates state from the
   * upstream provider (Anthropic / OpenAI / etc.) when supported.
   *
   * Returns silently when:
   *   - resumeAgent hook wasn't provided (older daemon embedding)
   *   - session is already alive (binding present)
   *   - session is a non-agent kind (terminal/command can't resume)
   *   - descriptor lacks adapterSessionId or adapterSlug (legacy row
   *     persisted before resume metadata was tracked)
   *
   * Concurrent prompt arrivals share one resume attempt via
   * `rt.resumePromise`.
   */
  const maybeResumeAgent = async (rt: SessionRuntime): Promise<void> => {
    if (rt.agentSession) return
    if (!resumeAgent) return
    if (rt.desc.kind !== "agent-cli") return
    const adapterSlug = rt.desc.adapterSlug ?? rt.adapterSlug
    const adapterSessionId = rt.desc.adapterSessionId
    const cwd = rt.desc.cwd
    if (!adapterSlug || !adapterSessionId || !cwd) return
    if (rt.resumePromise) {
      await rt.resumePromise
      return
    }
    rt.resumePromise = (async () => {
      appendLine(
        rt,
        `── resuming ${adapterSlug} session ${adapterSessionId} ──`,
        "stdout"
      )
      try {
        const fresh = await resumeAgent({
          adapterSlug,
          cwd,
          resumeSessionId: adapterSessionId,
          // Re-mount the persisted spawn-time toolset (orchestrator WP1).
          ...(rt.desc.mcpServers ? { mcpServers: rt.desc.mcpServers } : {}),
          // Keep pulsing lastActivityAt across a resume the same way the
          // original spawn did.
          onActivity: () => {
            rt.desc.lastActivityAt = new Date().toISOString()
            schedulePersist()
          },
        })
        if (!fresh) {
          appendLine(
            rt,
            `[error] resume failed: adapter '${adapterSlug}' returned null`,
            "stderr"
          )
          return
        }
        rt.agentSession = fresh
        rt.adapterSlug = adapterSlug
        rt.desc.adapterSessionId = fresh.sessionId
        // The resumed session is a fresh child process — refresh pid so
        // `processAlive` reflects the new process, not the dead one that
        // triggered this resume.
        rt.desc.pid = fresh.pid ?? null
        if (rt.desc.status !== "running") {
          rt.desc.status = "running"
          delete rt.desc.endedAt
          delete rt.desc.exitCode
          rt.emitter.emit("status", rt.desc.status)
        }
        schedulePersist()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        appendLine(rt, `[error] resume failed: ${msg}`, "stderr")
      }
    })()
    try {
      await rt.resumePromise
    } finally {
      rt.resumePromise = undefined
    }
  }

  /**
   * Resolve a session's usage snapshot from the descriptor's accumulated
   * signals: the adapter-reported cost (readUsage or a usage_update cost
   * block) is authoritative; otherwise tokens are priced against the in-repo
   * catalog (`deriveSessionUsage`), or tagged no-pricing when the model is
   * unknown. Pure read of `rt` — mutation is the caller's job.
   */
  const buildUsageSnapshot = (rt: SessionRuntime): SessionUsage =>
    deriveSessionUsage({
      ...(rt.desc.model !== undefined ? { model: rt.desc.model } : {}),
      ...(rt.adapterReportedCost && rt.desc.costUsd !== undefined
        ? { adapterCostUsd: rt.desc.costUsd }
        : {}),
      ...(rt.desc.tokensIn !== undefined ? { tokensIn: rt.desc.tokensIn } : {}),
      ...(rt.desc.tokensOut !== undefined ? { tokensOut: rt.desc.tokensOut } : {}),
      ...(rt.desc.contextSize !== undefined ? { contextSize: rt.desc.contextSize } : {}),
      ...(rt.desc.contextUsed !== undefined ? { contextUsed: rt.desc.contextUsed } : {}),
    })

  /**
   * Write a final `usage_snapshot` recap when an agent session exits (kill,
   * turn error, cost-cap, shutdown). Stamps `usageSource` on the descriptor
   * and skips writing when there's nothing measured (`source: "none"`) so a
   * never-run session doesn't leave an empty transcript file. Must run BEFORE
   * `transcriptWriter.close(id)`.
   */
  const recordExitUsageSnapshot = (rt: SessionRuntime): void => {
    if (rt.desc.kind !== "agent-cli") return
    const usage = buildUsageSnapshot(rt)
    rt.desc.usageSource = usage.source
    if (usage.source === "none") return
    transcriptWriter.recordUsageSnapshot(rt.desc.id, usage)
  }

  const runAgentTurn = async (
    rt: SessionRuntime,
    message: unknown
  ): Promise<void> => {
    if (!rt.agentSession) {
      throw new Error("runAgentTurn: session has no agentSession")
    }
    rt.busy = true
    rt.desc.busy = true             // mirror onto the public descriptor for session_monitor
    rt.emitter.emit("busy", true)
    rt.desc.awaitingInput = false  // clear stale awaiting-input flag from prior turn
    rt.desc.awaitingQuestion = undefined
    rt.desc.blockedOn = undefined  // clear stale blocked-on from prior turn
    rt.desc.pendingToolCallId = undefined
    let turnCompleted = false
    // Whether the adapter itself emitted a `turn-end` during this turn.
    // Drives the P5 guarantee: when the event stream ends WITHOUT one
    // (crash / exit / error / abort), the finally block synthesizes a
    // terminal `turn-end` — but only if the adapter didn't already send
    // one, so exactly one is emitted per turn.
    let sawTurnEnd = false
    // Set in `catch` to the abnormal-end reason ("error" | "aborted") so
    // the finally block can tag the synthesized turn-end correctly.
    let abnormalReason: string | undefined
    // Captures the driver's reported `turn-end` reason (e.g.
    // "completed", "watchdog-timeout") so it can ride along on the
    // `session:turn-end` bus event below — otherwise it's dropped after
    // `projectEvent` renders it into the ring buffer.
    let turnEndReason: string | undefined
    try {
      appendLine(
        rt,
        `\x1b[2m── ▶ ${typeof message === "string" ? message : JSON.stringify(message)} ──\x1b[0m`,
        "stdout"
      )
      transcriptWriter.recordPrompt(rt.desc.id, message)
      // ACP's `prompt` field expects ContentBlock[] (or a single
      // block). Hosts that send a raw string get auto-wrapped into
      // `{type: "text", text: "..."}` so callers can hand us
      // human-friendly prompts without shaping the wire format.
      const wrapped =
        typeof message === "string" ? { type: "text", text: message } : message
      for await (const evt of rt.agentSession.send(wrapped)) {
        // Capture the structured event to events.jsonl BEFORE
        // projectEvent flattens it into an ANSI ring-buffer line — the
        // only point downstream of the driver where the original
        // shape (tool arguments, plan entries, ...) still exists.
        transcriptWriter.recordEvent(rt.desc.id, evt)
        projectEvent(rt, evt)
        if (evt.kind === "turn-end") {
          sawTurnEnd = true
          turnEndReason = evt.reason
        }
      }
      turnCompleted = true
    } catch (err) {
      // A turn that ends by throwing is either a genuine error or an
      // ABORT (cancel()/kill()). Aborts must not be mislabelled as turn
      // errors — kill() already flipped status to "killed" and emitted
      // session:exited, and cancel() leaves the session alive for the
      // next turn — so only the genuine-error branch marks the session
      // errored. Either way the finally block below still guarantees a
      // terminal turn-end.
      if (isAbortError(err) || rt.desc.status === "killed") {
        abnormalReason = "aborted"
      } else {
        abnormalReason = "error"
        rt.desc.status = "error"
        rt.desc.endedAt = new Date().toISOString()
        appendLine(
          rt,
          `[turn error] ${err instanceof Error ? err.message : String(err)}`,
          "stderr"
        )
        recordExitUsageSnapshot(rt)
        schedulePersist()
        emitExited(rt)
      }
    } finally {
      rt.busy = false
      rt.desc.busy = false           // mirror onto the public descriptor for session_monitor
      rt.emitter.emit("busy", false)
      // Safety net: a tool-call that never receives its tool-result (child
      // crashed, stream ended early) must not leave the session flagged
      // blocked forever — the turn is over, nothing is pending anymore.
      rt.desc.blockedOn = undefined
      rt.desc.pendingToolCallId = undefined

      // ── P5: guarantee exactly one terminal turn-end per turn ──────────
      // If the adapter's event stream ended without a turn-end (generator
      // returned early, subprocess exited, threw, or was aborted), inject
      // one so downstream orchestration can rely on turn-end as a uniform
      // completion signal instead of hanging. Idempotent — `sawTurnEnd`
      // short-circuits when the adapter already produced one.
      if (!sawTurnEnd) {
        const reason =
          abnormalReason ??
          (rt.desc.status === "killed" ? "aborted" : "exited")
        const synthetic: AgentStreamEvent = { kind: "turn-end", reason }
        // Record to the durable transcript first (matches the in-loop
        // order: recordEvent before projectEvent), then flatten into the
        // ring buffer so /stream + events.jsonl consumers both see it.
        transcriptWriter.recordEvent(rt.desc.id, synthetic)
        projectEvent(rt, synthetic)
        sawTurnEnd = true
        turnEndReason = reason
      }

      if (turnCompleted) {
        // Record that a turn finished so a late `session_monitor` (subscribed
        // after a fast turn already ended) can still fast-return.
        rt.desc.turnsCompleted = (rt.desc.turnsCompleted ?? 0) + 1

        // ── Cost refresh (best-effort) ───────────────────────────────
        // The adapter's own reader (e.g. hermes state.db) is authoritative —
        // a returned `costUsd` marks the session as adapter-priced.
        if (rt.readUsage) {
          try {
            const usage = await rt.readUsage()
            if (usage) {
              if (usage.costUsd !== undefined) {
                rt.desc.costUsd = usage.costUsd
                rt.adapterReportedCost = true
              }
              if (usage.tokensIn !== undefined) rt.desc.tokensIn = usage.tokensIn
              if (usage.tokensOut !== undefined) rt.desc.tokensOut = usage.tokensOut

              // Record a `usage_update` into the transcript so non-claude
              // adapters (hermes reads its state.db here; claude-code emits
              // this inline over ACP) carry the SAME token/cost telemetry in
              // events.jsonl. Only when the reader actually returned a signal
              // — never synthesize a usage event from nothing. Shape is
              // identical to the ACP-arm's usage_update: size/used default to
              // 0 (this reader carries no context-window figure, and
              // `projectEvent` guards on >0 so the 0s never clobber a real
              // size already mirrored onto the descriptor).
              if (
                usage.costUsd !== undefined ||
                usage.tokensIn !== undefined ||
                usage.tokensOut !== undefined
              ) {
                const usageEvent: AgentStreamEvent = {
                  kind: "usage_update",
                  size: 0,
                  used: 0,
                  ...(usage.costUsd !== undefined
                    ? { cost: { amount: usage.costUsd, currency: "USD" } }
                    : {}),
                  ...(usage.tokensIn !== undefined
                    ? { tokensIn: usage.tokensIn }
                    : {}),
                  ...(usage.tokensOut !== undefined
                    ? { tokensOut: usage.tokensOut }
                    : {}),
                }
                transcriptWriter.recordEvent(rt.desc.id, usageEvent)
              }
            }
          } catch {
            // best-effort — swallow
          }
        }

        // ── Resolve usage source (adapter / computed / no-pricing / none)
        //    and write the durable turn-boundary recap. Runs on every
        //    turn-end, even without a session-event bus wired.
        const usage = buildUsageSnapshot(rt)
        rt.desc.usageSource = usage.source
        rt.desc.costUsd = usage.costUsd
        transcriptWriter.recordUsageSnapshot(rt.desc.id, usage)

        // ── Cost cap (best-effort, turn-granular) ────────────────────
        const overBudget =
          rt.maxCostUsd !== undefined &&
          rt.desc.costUsd !== undefined &&
          rt.desc.costUsd > rt.maxCostUsd
        if (overBudget) {
          appendLine(
            rt,
            `[cost-cap] cost $${rt.desc.costUsd} exceeds max $${rt.maxCostUsd} — killing session`,
            "stderr",
          )
          rt.desc.status = "killed"
          rt.desc.endedAt = new Date().toISOString()
          void rt.agentSession?.close().catch(() => undefined)
          void transcriptWriter.close(rt.desc.id)
          tracedSessions.delete(rt.desc.id)
        }

        if (sessionEvents) {
          // No driver reports a structured "agent-prompt" today (every
          // currently-supported adapter auto-answers ACP permission
          // requests rather than surfacing them) — fall back to a
          // best-effort scan of the transcript tail so awaiting-input still
          // carries SOME signal beyond a bare boolean.
          if (rt.desc.awaitingInput && !rt.desc.awaitingQuestion) {
            rt.desc.awaitingQuestion = deriveHeuristicQuestion(rt.recentLines)
          }

          const ts = new Date().toISOString()
          sessionEvents.emit({
            type: "session:turn-end",
            sessionId: rt.desc.id,
            awaitingInput: rt.desc.awaitingInput ?? false,
            label: rt.desc.label,
            ts,
            ...(rt.desc.awaitingQuestion ? { question: rt.desc.awaitingQuestion } : {}),
            ...(turnEndReason ? { reason: turnEndReason } : {}),
          })
          if (rt.desc.awaitingInput) {
            sessionEvents.emit({
              type: "session:awaiting-input",
              sessionId: rt.desc.id,
              label: rt.desc.label,
              ts,
              ...(rt.desc.awaitingQuestion ? { question: rt.desc.awaitingQuestion } : {}),
            })
          }
        }
        if (overBudget) emitExited(rt)
      } else {
        // ── Abnormal turn end (error / abort) ────────────────────────
        // The adapter's stream broke before a turn-end. We already
        // synthesized the terminal turn-end above; still stamp
        // turnsCompleted and emit the bus turn-end so a `session_monitor`
        // (or any consumer waiting on completion) doesn't hang on a turn
        // that will never signal done through the normal path.
        rt.desc.turnsCompleted = (rt.desc.turnsCompleted ?? 0) + 1
        if (sessionEvents) {
          sessionEvents.emit({
            type: "session:turn-end",
            sessionId: rt.desc.id,
            awaitingInput: rt.desc.awaitingInput ?? false,
            label: rt.desc.label,
            ts: new Date().toISOString(),
            ...(turnEndReason ? { reason: turnEndReason } : {}),
          })
        }
      }
    }
  }

  const wireOutputStreams = (rt: SessionRuntime): void => {
    const onChunk =
      (stream: "stdout" | "stderr") =>
      (chunk: Buffer | string): void => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
        for (const line of text.split(/\r?\n/)) {
          if (line.length > 0) appendLine(rt, line, stream)
        }
      }
    // Only called from spawn() which always sets rt.child — narrow
    // here so the stream listeners don't trip the optional-chain.
    if (!rt.child) return
    rt.child.stdout?.on("data", onChunk("stdout"))
    rt.child.stderr?.on("data", onChunk("stderr"))
  }

  return {
    spawn(input) {
      const id = input.id ?? `sess_${randomUUID().slice(0, 8)}`
      if (sessions.has(id)) {
        throw new Error(`sessions.spawn: id "${id}" already in use`)
      }
      const env = { ...process.env, ...(input.env ?? {}) }
      // Filter out Node bookkeeping that confuses subprocesses.
      delete env.NODE_OPTIONS
      const [bin, ...args] = input.argv
      if (!bin) throw new Error("sessions.spawn: argv must include a binary")
      // Close stdin by default — most agent CLIs spawn-and-prompt
      // (claude/codex/aider/etc.) read argv for the prompt and will
      // otherwise sit waiting for piped input. Caller opts in to a
      // writeable stdin via `keepStdin: true` (terminal/PTY kinds).
      const stdinMode = input.keepStdin ? "pipe" : "ignore"
      const child = spawn(bin, args, {
        cwd: input.cwd,
        env: env as NodeJS.ProcessEnv,
        stdio: [stdinMode, "pipe", "pipe"],
      })
      const desc: SessionDescriptor = {
        id,
        kind: input.kind,
        workspaceSlug: input.workspaceSlug,
        command: [bin, ...args].map(quoteArg).join(" "),
        pid: child.pid ?? null,
        status: "starting",
        startedAt: new Date().toISOString(),
        argv: input.argv,
        cwd: input.cwd,
        ...(input.label ? { label: input.label } : {}),
      }
      const rt: SessionRuntime = {
        desc,
        child,
        recentLines: [],
        recentBytes: [],
        recentBytesSize: 0,
        emitter: new EventEmitter(),
        busy: false,
        textBuf: "",
        thoughtBuf: "",
      }
      // Don't crash the daemon when no listener is attached — the
      // emitter's "error" event would otherwise propagate.
      rt.emitter.setMaxListeners(50)

      sessions.set(id, rt)
      wireOutputStreams(rt)

      child.once("spawn", () => {
        desc.status = "running"
        rt.emitter.emit("status", desc.status)
        schedulePersist()
      })
      child.once("error", err => {
        desc.status = "error"
        desc.endedAt = new Date().toISOString()
        appendLine(rt, `[spawn error] ${err.message}`, "stderr")
        rt.emitter.emit("status", desc.status)
        schedulePersist()
        emitExited(rt)
      })
      child.once("exit", (code, signal) => {
        if (signal && desc.status !== "killed") desc.status = "killed"
        else if (desc.status === "running" || desc.status === "starting") {
          desc.status = "exited"
        }
        desc.endedAt = new Date().toISOString()
        if (typeof code === "number") desc.exitCode = code
        rt.emitter.emit("status", desc.status)
        schedulePersist()
        emitExited(rt)
      })
      schedulePersist()
      return desc
    },
    register(input) {
      if (sessions.has(input.id)) {
        // Already adopted (re-tracking is a noop). Return the
        // existing descriptor so callers don't have to special-case.
        const existing = sessions.get(input.id)
        if (existing) return existing.desc
      }
      const desc: SessionDescriptor = {
        id: input.id,
        kind: input.kind ?? "command",
        workspaceSlug: input.workspaceSlug,
        command: input.command,
        pid: input.child.pid ?? null,
        status: input.child.killed ? "killed" : "running",
        startedAt: new Date().toISOString(),
        ...(input.label ? { label: input.label } : {}),
      }
      const rt: SessionRuntime = {
        desc,
        child: input.child,
        recentLines: [],
        recentBytes: [],
        recentBytesSize: 0,
        emitter: new EventEmitter(),
        busy: false,
        textBuf: "",
        thoughtBuf: "",
      }
      rt.emitter.setMaxListeners(50)
      sessions.set(input.id, rt)
      wireOutputStreams(rt)
      // Wire exit so the descriptor flips when the adopted child
      // dies — same handlers as spawn() but registered post-hoc
      // because the child is already alive.
      input.child.once("exit", (code, signal) => {
        if (signal && desc.status !== "killed") desc.status = "killed"
        else if (desc.status === "running") desc.status = "exited"
        desc.endedAt = new Date().toISOString()
        if (typeof code === "number") desc.exitCode = code
        rt.emitter.emit("status", desc.status)
        schedulePersist()
        emitExited(rt)
      })
      input.child.once("error", err => {
        desc.status = "error"
        desc.endedAt = new Date().toISOString()
        appendLine(rt, `[child error] ${err.message}`, "stderr")
        rt.emitter.emit("status", desc.status)
        schedulePersist()
        emitExited(rt)
      })
      schedulePersist()
      return desc
    },
    spawnAgent(input) {
      const id = `sess_${randomUUID().slice(0, 8)}`
      const priorCommandSessionId = findPriorCommandSessionId(sessions, input.cwd)
      const desc: SessionDescriptor = {
        id,
        kind: "agent-cli",
        workspaceSlug: input.workspaceSlug,
        command: input.commandPreview ?? `${input.adapterSlug} (agent)`,
        pid: input.agentSession.pid ?? null,
        status: "running", // driver already started the session
        startedAt: new Date().toISOString(),
        cwd: input.cwd,
        adapterSlug: input.adapterSlug,
        // ACP-level session id — sticks across daemon restart so
        // `agentproto sessions restart <id>` can pass it as
        // `resumeSessionId` and the adapter reattaches to the prior
        // conversation rather than starting blank.
        adapterSessionId: input.agentSession.sessionId,
        ...(input.label ? { label: input.label } : {}),
        // Persist the spawn-time MCP mounts so resume re-mounts the same
        // toolset (orchestrator WP1). Reference-only shape — no secrets.
        ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
        // Parent attribution + depth (orchestrator WP4). Depth is always
        // recorded (defaults to 0) so subtree/depth logic never has to
        // distinguish "absent" from "root".
        ...(input.parentSessionId
          ? { parentSessionId: input.parentSessionId }
          : {}),
        depth: input.depth ?? 0,
        ...(input.model ? { model: input.model } : {}),
        ...(priorCommandSessionId ? { priorCommandSessionId } : {}),
      }
      if (input.trace ?? opts?.langfuseTracingDefault ?? false) {
        tracedSessions.add(id)
      }
      const rt: SessionRuntime = {
        desc,
        agentSession: input.agentSession,
        adapterSlug: input.adapterSlug,
        recentLines: [],
        recentBytes: [],
        recentBytesSize: 0,
        emitter: new EventEmitter(),
        busy: false,
        textBuf: "",
        thoughtBuf: "",
        maxCostUsd: input.maxCostUsd,
        readUsage: input.readUsage,
      }
      rt.emitter.setMaxListeners(50)
      sessions.set(id, rt)
      appendLine(
        rt,
        `── ${input.adapterSlug} agent session ${input.agentSession.sessionId} (cwd ${input.cwd}) ──`,
        "stdout"
      )
      schedulePersist()
      // Fire-and-forget the initial prompt (if any). Errors land in
      // the ring buffer + bump status to "error" but don't reject
      // the spawn — the descriptor was already returned.
      if (input.initialPrompt) {
        void runAgentTurn(rt, input.initialPrompt).catch(err => {
          appendLine(
            rt,
            `[turn error] ${err instanceof Error ? err.message : String(err)}`,
            "stderr"
          )
        })
      }
      return desc
    },
    spawnPty(input) {
      if (!ptyFactory) {
        throw new Error(
          "sessions.spawnPty: no PTY factory configured (node-pty optional dep missing in the daemon)"
        )
      }
      const id = `sess_${randomUUID().slice(0, 8)}`
      // Reject the name only when the prior holder is still alive —
      // killed/exited/error sessions keep their descriptor in the
      // registry for history, but their name is free to reuse so
      // `stop X && terminal --name X` round-trips cleanly.
      if (input.name) {
        for (const rt of sessions.values()) {
          if (rt.desc.name !== input.name) continue
          const status = rt.desc.status
          if (status === "running" || status === "starting") {
            throw new Error(
              `sessions.spawnPty: name "${input.name}" already in use by ${rt.desc.id} (status=${status})`,
            )
          }
          // Free the name on the dead session so id-or-name lookup
          // resolves to the NEW one. The old descriptor stays in the
          // registry (you can still find it by id in the list).
          rt.desc.name = undefined
        }
      }
      const [bin, ...args] = input.argv
      if (!bin) {
        throw new Error("sessions.spawnPty: argv must include a binary")
      }
      // node-pty forces its own minimal env unless we forward — pass
      // process.env merged with caller overrides. The factory layer
      // also forces TERM=xterm-256color so alt-screen apps render.
      const env = { ...(process.env as Record<string, string>), ...(input.env ?? {}) }
      delete env.NODE_OPTIONS
      const pty: PtyProcess = ptyFactory({
        command: bin,
        args,
        cwd: input.cwd,
        env,
        cols: input.cols,
        rows: input.rows,
      })
      const priorCommandSessionId = findPriorCommandSessionId(sessions, input.cwd)
      const desc: SessionDescriptor = {
        id,
        kind: "terminal",
        workspaceSlug: input.workspaceSlug,
        command: [bin, ...args].map(quoteArg).join(" "),
        pid: pty.pid,
        status: "running",
        startedAt: new Date().toISOString(),
        pty: true,
        argv: input.argv,
        cwd: input.cwd,
        ...(input.name ? { name: input.name } : {}),
        ...(input.label ? { label: input.label } : {}),
        ...(priorCommandSessionId ? { priorCommandSessionId } : {}),
      }
      const rt: SessionRuntime = {
        desc,
        pty,
        ptySubscribers: new Map(),
        recentLines: [],
        recentBytes: [],
        recentBytesSize: 0,
        emitter: new EventEmitter(),
        busy: false,
        textBuf: "",
        thoughtBuf: "",
      }
      rt.emitter.setMaxListeners(50)
      sessions.set(id, rt)
      pty.onData((chunk: string) => {
        // node-pty emits utf-8 strings. Convert once at the boundary
        // so the ring buffer + emitter consumers all see Buffer.
        appendBytes(rt, Buffer.from(chunk, "utf8"))
      })
      pty.onExit(evt => {
        if (rt.desc.status !== "killed") {
          rt.desc.status = "exited"
        }
        rt.desc.endedAt = new Date().toISOString()
        if (typeof evt.exitCode === "number") rt.desc.exitCode = evt.exitCode
        rt.emitter.emit("exit", evt)
        rt.emitter.emit("status", rt.desc.status)
        void terminalTranscriptWriter.close(rt.desc.id)
        schedulePersist()
        emitExited(rt)
      })
      schedulePersist()
      return desc
    },
    recordCommand(input) {
      const id = `sess_${randomUUID().slice(0, 8)}`
      const now = new Date()
      // Backdate startedAt by durationMs — the command already ran to
      // completion by the time this is called, so this is the best
      // available estimate of when it actually started.
      const startedAt = new Date(now.getTime() - Math.max(0, input.durationMs)).toISOString()
      const argv = [input.command, ...input.args]
      const desc: SessionDescriptor = {
        id,
        kind: "command",
        workspaceSlug: input.workspaceSlug,
        command: argv.map(quoteArg).join(" "),
        pid: null,
        status: input.exitCode === 0 ? "exited" : "error",
        startedAt,
        endedAt: now.toISOString(),
        exitCode: input.exitCode,
        argv,
        cwd: input.cwd,
        ...(input.label ? { label: input.label } : {}),
      }
      const rt: SessionRuntime = {
        desc,
        recentLines: [],
        recentBytes: [],
        recentBytesSize: 0,
        emitter: new EventEmitter(),
        busy: false,
        textBuf: "",
        thoughtBuf: "",
      }
      sessions.set(id, rt)
      writeCommandLogEntry(
        id,
        {
          ts: now.toISOString(),
          command: input.command,
          args: input.args,
          cwd: input.cwd,
          exitCode: input.exitCode,
          signal: input.signal,
          durationMs: input.durationMs,
          stdout: input.stdout,
          stderr: input.stderr,
          ...(input.truncated ? { truncated: true } : {}),
        },
        transcriptBaseDir,
      )
      schedulePersist()
      // No live process — the session is already over, so emit its
      // `session:exited` right away (mirrors kill()'s "agent-cli has no
      // OS exit event — emit here" rule just below).
      emitExited(rt)
      return desc
    },
    async readCommandLog(sessionId) {
      const rt = sessions.get(sessionId)
      if (!rt || rt.desc.kind !== "command") return null
      return readCommandLogEntry(sessionId, transcriptBaseDir)
    },
    registerBrowser(input) {
      const inputLocation = input.location ?? "local"
      // Idempotent: reuse an alive session for the same (adapterId, port, location).
      // Location is part of the key so a cloud call never returns a local session.
      for (const rt of sessions.values()) {
        if (
          rt.desc.kind === "browser" &&
          rt.desc.browserAdapterId === input.adapterId &&
          rt.desc.browserPort === input.port &&
          (rt.desc.browserLocation ?? "local") === inputLocation &&
          (rt.desc.status === "running" || rt.desc.status === "starting")
        ) {
          // Update label on idempotent hit so callers can stamp correlation
          // context (guild/op/workItem) onto a long-lived browser session.
          if (input.label !== undefined) {
            rt.desc.label = input.label
            schedulePersist()
          }
          return rt.desc
        }
      }
      const id = `sess_${randomUUID().slice(0, 8)}`
      const desc: SessionDescriptor = {
        id,
        kind: "browser",
        workspaceSlug: "",
        command: `${input.adapterId} (browser)`,
        pid: input.pid ?? null,
        status: input.status ?? "running",
        startedAt: new Date().toISOString(),
        browserAdapterId: input.adapterId,
        browserPort: input.port,
        browserBaseUrl: input.baseUrl,
        browserLocation: inputLocation,
        ...(input.label ? { label: input.label } : {}),
      }
      const rt: SessionRuntime = {
        desc,
        browserStop: input.stop,
        recentLines: [],
        recentBytes: [],
        recentBytesSize: 0,
        emitter: new EventEmitter(),
        busy: false,
        textBuf: "",
        thoughtBuf: "",
      }
      rt.emitter.setMaxListeners(50)
      sessions.set(id, rt)
      schedulePersist()
      return desc
    },
    async sendPrompt(id, message) {
      const rtPre = sessions.get(id)
      if (rtPre) await maybeResumeAgent(rtPre)
      const rt = validateAgentTurn(id, "sendPrompt")
      await runAgentTurn(rt, message)
    },
    async enqueuePrompt(id, message, opts) {
      // Admission phase — AWAITED, unlike the turn itself below. This
      // is what makes `{queued: true}` truthful: a dead (exited/
      // killed/error) session gets one resume attempt, then
      // validateAgentTurn throws `SessionNotAliveError` (or the busy /
      // wrong-kind errors) synchronously enough for the caller (MCP
      // `agent_prompt`, HTTP `?wait=false`) to surface it instead of
      // reporting success for a prompt that will never be dispatched.
      const rtPre = sessions.get(id)
      if (!rtPre) {
        throw new Error(`enqueuePrompt: no session "${id}"`)
      }
      // `interrupt` only ever changes behavior on a mid-turn session —
      // an idle session falls straight through to the normal admission
      // path below, byte-identical to `interrupt` omitted/false. Cancel
      // THEN await the turn actually settling (busy → false) BEFORE
      // `validateAgentTurn` runs, so admission is never bypassed — it's
      // only ever reached once the prior turn is genuinely over.
      if (opts?.interrupt && rtPre.busy) {
        await interruptInFlightTurn(rtPre, id)
      }
      await maybeResumeAgent(rtPre)
      const rt = validateAgentTurn(id, "enqueuePrompt")
      // Execution phase — fire-and-forget from here on. Errors during
      // the turn itself (network drop, child died mid-turn) land in
      // the ring buffer as `[error]` lines so the SSE consumer sees
      // them; admission already succeeded so there's nothing else to
      // report back to the original caller.
      void runAgentTurn(rt, message).catch(err => {
        appendLine(
          rtPre,
          `[error] ${err instanceof Error ? err.message : String(err)}`,
          "stderr"
        )
      })
    },
    pulseActivity(id) {
      const rt = sessions.get(id)
      if (!rt) return
      rt.desc.lastActivityAt = new Date().toISOString()
      schedulePersist()
    },
    list() {
      return Array.from(sessions.values())
        .map(s => s.desc)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .map(desc => {
          stampProcessAlive(desc)
          return desc
        })
    },
    get(id) {
      const desc = sessions.get(id)?.desc
      if (desc) stampProcessAlive(desc)
      return desc
    },
    attach(id, onLine) {
      const rt = sessions.get(id)
      if (!rt) return null
      // Backfill: synchronously replay the ring buffer so attaches
      // see the recent context, then subscribe for new lines.
      for (const line of rt.recentLines) onLine(line, "stdout")
      const handler = (evt: {
        line: string
        stream: "stdout" | "stderr"
      }): void => onLine(evt.line, evt.stream)
      rt.emitter.on("line", handler)
      return () => rt.emitter.off("line", handler)
    },
    attachPty(id, initial, onData, onExit) {
      const rt = sessions.get(id)
      if (!rt || !rt.pty || !rt.ptySubscribers) return null
      // Backfill: flush the byte ring buffer so a fresh attach lands
      // on the recent screenful. Alt-screen apps repaint on next
      // input but a snapshot is still better than blank.
      for (const chunk of rt.recentBytes) onData(chunk)
      // Subscriber registration: a monotonically-growing key so the
      // size map can hold the per-subscriber dims and detach is O(1).
      const subId = nextSubId++
      rt.ptySubscribers.set(subId, { cols: initial.cols, rows: initial.rows })
      reconcilePtySize(rt)
      const dataHandler = (chunk: Buffer): void => onData(chunk)
      const exitHandler = (evt: {
        exitCode: number
        signal?: number
      }): void => onExit(evt)
      rt.emitter.on("data", dataHandler)
      rt.emitter.once("exit", exitHandler)
      return {
        write(data: string): void {
          if (!rt.pty) return
          try {
            rt.pty.write(data)
          } catch {
            // PTY already exited — drop the input silently.
          }
        },
        resize(cols: number, rows: number): void {
          if (!rt.ptySubscribers) return
          rt.ptySubscribers.set(subId, { cols, rows })
          reconcilePtySize(rt)
        },
        detach(): void {
          rt.emitter.off("data", dataHandler)
          rt.emitter.off("exit", exitHandler)
          rt.ptySubscribers?.delete(subId)
          reconcilePtySize(rt)
        },
      }
    },
    findByIdOrName(query) {
      const direct = sessions.get(query)
      if (direct) {
        stampProcessAlive(direct.desc)
        return direct.desc
      }
      for (const rt of sessions.values()) {
        if (rt.desc.name === query) {
          stampProcessAlive(rt.desc)
          return rt.desc
        }
      }
      return undefined
    },
    writeTerminalInput(id, data) {
      const rt = sessions.get(id)
      if (!rt || !rt.pty) return false
      try {
        rt.pty.write(data)
        return true
      } catch {
        return false
      }
    },
    readTerminalOutput(id, lastBytes) {
      const rt = sessions.get(id)
      if (!rt || !rt.pty) return null
      const joined = Buffer.concat(rt.recentBytes, rt.recentBytesSize)
      if (typeof lastBytes === "number" && lastBytes > 0 && joined.byteLength > lastBytes) {
        return joined.subarray(joined.byteLength - lastBytes)
      }
      return joined
    },
    kill(id, signal = "SIGTERM") {
      const rt = sessions.get(id)
      if (!rt) return false
      if (
        rt.desc.status === "exited" ||
        rt.desc.status === "killed" ||
        rt.desc.status === "error"
      ) {
        return false
      }
      rt.desc.status = "killed"
      rt.desc.endedAt = new Date().toISOString()
      // Close agent session first (graceful protocol shutdown), then
      // SIGTERM the underlying child/pty if any. Either branch is a
      // best-effort — the descriptor flip is what the UI surfaces.
      if (rt.agentSession) {
        // Durable usage recap on exit — before close() flushes the stream.
        recordExitUsageSnapshot(rt)
        void rt.agentSession.close().catch(() => undefined)
        void transcriptWriter.close(rt.desc.id)
        tracedSessions.delete(rt.desc.id)
      }
      if (rt.pty) {
        try {
          rt.pty.kill(signal)
        } catch {
          // pty already gone — fall through
        }
        void terminalTranscriptWriter.close(rt.desc.id)
      }
      rt.child?.kill(signal)
      if (rt.browserStop) {
        void rt.browserStop().catch(() => undefined)
      }
      schedulePersist()
      // Agent-cli sessions have no OS exit event — emit here.
      // Child/PTY sessions emit from their exit handlers; the
      // exitedEmitted guard prevents a duplicate from kill() AND exit.
      emitExited(rt)
      return true
    },
    forget(id) {
      const rt = sessions.get(id)
      if (!rt) return false
      // Don't leak: tear down the emitter so backfill listeners stop.
      rt.emitter.removeAllListeners()
      void transcriptWriter.close(id)
      void terminalTranscriptWriter.close(id)
      tracedSessions.delete(id)
      sessions.delete(id)
      schedulePersist()
      return true
    },
    shutdown() {
      shutdownImpl()
    },
  }

  /**
   * The actual shutdown logic, hoisted so both the explicit
   * `shutdown()` method AND the `process.on("exit")` safety net
   * can call it. Sync (no awaits) so it works in the `exit` event
   * handler.
   *
   * Idempotent — `serve --interactive` calls gateway.stop() twice in
   * some Ctrl-C race paths (parent SIGINT handler + the child-exit
   * promise both fire), and `process.on("exit")` ALSO fires at the
   * end of every termination path. Without the guard, the second
   * call clears the already-empty sessions Map and writes an empty
   * snapshot back to sessions.json, wiping history.
   */
  function shutdownImpl(): void {
    if (shutdownDone) return
    shutdownDone = true
    if (persistTimer) clearTimeout(persistTimer)
    if (persist) {
      try {
        process.off("exit", onProcessExit)
      } catch {
        // ignore — handler may not be installed
      }
    }
    // Mark any still-alive sessions as killed BEFORE the final
    // flush so the snapshot accurately reflects what happened. On
    // the next boot, load reads these and we won't have to guess
    // ("was running last time → assume killed" is then a no-op).
    const nowIso = new Date().toISOString()
    for (const rt of sessions.values()) {
      rt.emitter.removeAllListeners()
      if (
        rt.desc.status === "running" ||
        rt.desc.status === "starting"
      ) {
        rt.desc.status = "killed"
        rt.desc.endedAt = nowIso
        if (rt.agentSession) {
          recordExitUsageSnapshot(rt)
          void rt.agentSession.close().catch(() => undefined)
        }
        if (rt.pty) {
          try {
            rt.pty.kill("SIGTERM")
          } catch {
            // already exited
          }
        }
        rt.child?.kill("SIGTERM")
      }
    }
    void transcriptWriter.closeAll()
    void terminalTranscriptWriter.closeAll()
    // Sync flush so quick sessions (spawned + ended in less than
    // PERSIST_DEBOUNCE_MS) aren't lost. The debounced async write
    // may have been cancelled by clearTimeout above, but a 200-byte
    // sync write at shutdown is cheap and the data needs to land.
    if (persist) {
      try {
        const snapshot = {
          savedAt: nowIso,
          // Strip processAlive — see the matching comment in
          // persistSnapshot(), same live-OS-query rationale applies here.
          sessions: Array.from(sessions.values()).map(s => {
            const { processAlive: _processAlive, ...rest } = s.desc
            return rest
          }),
        }
        mkdirSync(dirname(persistPath), { recursive: true })
        writeFileSync(persistPath, JSON.stringify(snapshot, null, 2) + "\n")
      } catch {
        // best-effort — same policy as the async path
      }
    }
    sessions.clear()
  }
}

/**
 * Read the persisted snapshot at boot and reinflate session
 * descriptors as historical "ghost" entries. Sync-read because this
 * runs once at construction, the file is small (~200 entries), and
 * keeping it sync avoids making createSessionsRegistry async (would
 * cascade through createGateway + every embedding host).
 *
 * Anything that was "running"/"starting" when the daemon last died
 * gets re-classified as "killed" with endedAt=now — we can't tell
 * if the orphan PID survived the daemon's exit, and pretending it's
 * still alive would make attach/kill calls fail mysteriously. The
 * descriptor stays in the registry for history; the dashboard sees
 * it under SESSIONS, the user can `d` to forget.
 *
 * Ghosts carry NO live child / agentSession / pty — calls that
 * would interact with the underlying process degrade to no-ops.
 * Output ring buffers (lines + bytes) are empty: we don't persist
 * those, only the descriptor metadata.
 */
function loadHistorySnapshot(
  persistPath: string,
  sessions: Map<string, SessionRuntime>,
): void {
  let raw: string
  try {
    raw = readFileSync(persistPath, "utf8")
  } catch {
    return // ENOENT etc. — first boot, no history.
  }
  let parsed: { sessions?: SessionDescriptor[] }
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.warn(
      `[sessions] history file ${persistPath} is malformed — ignoring`,
    )
    return
  }
  if (!Array.isArray(parsed.sessions)) return
  // Newest first so the FIFO cap drops oldest.
  const sorted = parsed.sessions
    .filter((s): s is SessionDescriptor => !!s && typeof s.id === "string")
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, HISTORY_CAP)
  const now = new Date().toISOString()
  for (const desc of sorted) {
    if (sessions.has(desc.id)) continue // collision with a live entry — keep live
    const wasAlive = desc.status === "running" || desc.status === "starting"
    const reclassified: SessionDescriptor = wasAlive
      ? {
          ...desc,
          status: "killed",
          endedAt: desc.endedAt ?? now,
        }
      : desc
    const rt: SessionRuntime = {
      desc: reclassified,
      recentLines: [],
      recentBytes: [],
      recentBytesSize: 0,
      emitter: new EventEmitter(),
      busy: false,
      textBuf: "",
      thoughtBuf: "",
    }
    rt.emitter.setMaxListeners(50)
    sessions.set(desc.id, rt)
  }
}

/** Minimal shell-quote — wraps args containing whitespace or quotes
 *  so the rendered `command` field is copy-pasteable. */
function quoteArg(arg: string): string {
  if (arg === "") return '""'
  if (/^[a-zA-Z0-9._/=:@,+-]+$/.test(arg)) return arg
  return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`
}
