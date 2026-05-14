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

import { spawn, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdirSync, writeFileSync, promises as fs, readFileSync } from "node:fs"
import { RESUME_STRATEGIES } from "./resume-strategies.js"
import { dirname, resolve } from "node:path"
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
  toolName?: string
  isError?: boolean
  reason?: string
  error?: { message: string; code?: number; data?: unknown }
}

export const SESSIONS_FILE_PATH = (): string =>
  resolve(homedir(), ".agentproto", "sessions.json")

export type SessionKind = "terminal" | "agent-cli" | "command"
export type SessionStatus =
  | "starting"
  | "running"
  | "exited"
  | "killed"
  | "error"

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
  /** ACP-level session id (the adapter's own handle — claude-code's
   *  conversation id, hermes' chat id, …). Set at spawnAgent time
   *  from `agentSession.sessionId`. Survives across daemon restarts
   *  via sessions.json so `restart` can pass it as `resumeSessionId`
   *  and reattach to the prior conversation history. */
  adapterSessionId?: string
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

/** Strip CSI / SGR ANSI sequences so resume-pattern matching works
 *  on dim/coloured output. Liberal regex covering most cases — we
 *  don't need byte-perfect parsing here. */
function stripAnsiCodes(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
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
  /** Send a follow-up turn to a live agent session. Throws when the
   *  session is missing, not an agent-cli kind, or busy. The events
   *  stream into the existing ring buffer + line emitter so /stream
   *  consumers see them as they arrive. */
  sendPrompt(id: string, message: unknown): Promise<void>
  /** Fire-and-forget variant of `sendPrompt`. Validates the same
   *  preconditions synchronously — throws on missing session / wrong
   *  kind / busy — but returns immediately after the turn is started,
   *  letting the caller stream output via the SSE endpoint instead of
   *  blocking on the full turn. Async errors during the turn are
   *  pushed into the ring buffer as `[error]` lines so `/stream`
   *  subscribers see them. Used by the web UI's chat input where a
   *  long turn would otherwise freeze the textbox. */
  enqueuePrompt(id: string, message: unknown): void
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

export function createSessionsRegistry(opts?: {
  /** Override the persistence path — tests pin a tmpdir. */
  persistPath?: string
  /** Disable persistence entirely. */
  persist?: boolean
  /** PTY factory (node-pty wrapper). When omitted, `spawnPty()`
   *  throws — the daemon advertises PTY support only when the cli
   *  layer resolved node-pty successfully. */
  spawnPty?: PtyFactory
}): SessionsRegistry {
  const persistPath = opts?.persistPath ?? SESSIONS_FILE_PATH()
  const persist = opts?.persist ?? true
  const ptyFactory = opts?.spawnPty
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
        sessions: Array.from(sessions.values()).map(s => s.desc),
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
      case "tool-call":
        appendLine(
          rt,
          `\x1b[36m[tool] ${evt.toolName ?? "?"}\x1b[0m`,
          "stdout"
        )
        break
      case "tool-result":
        if (evt.isError)
          appendLine(rt, `\x1b[31m[tool-error]\x1b[0m`, "stderr")
        break
      case "agent-prompt":
        appendLine(rt, `\x1b[33m[awaiting input]\x1b[0m`, "stdout")
        break
      case "turn-end": {
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
   * missing session / wrong kind / busy so both code paths surface
   * the exact same error messages — the only difference is whether
   * the caller awaits the turn.
   */
  const validateAgentTurn = (id: string, caller: string): SessionRuntime => {
    const rt = sessions.get(id)
    if (!rt) throw new Error(`${caller}: no session "${id}"`)
    if (!rt.agentSession) {
      throw new Error(
        `${caller}: session "${id}" is not an agent session (kind=${rt.desc.kind})`
      )
    }
    if (rt.busy) {
      throw new Error(
        `${caller}: session "${id}" is mid-turn — wait for it to finish or cancel`
      )
    }
    return rt
  }

  const runAgentTurn = async (
    rt: SessionRuntime,
    message: unknown
  ): Promise<void> => {
    if (!rt.agentSession) {
      throw new Error("runAgentTurn: session has no agentSession")
    }
    rt.busy = true
    try {
      appendLine(
        rt,
        `\x1b[2m── ▶ ${typeof message === "string" ? message : JSON.stringify(message)} ──\x1b[0m`,
        "stdout"
      )
      // ACP's `prompt` field expects ContentBlock[] (or a single
      // block). Hosts that send a raw string get auto-wrapped into
      // `{type: "text", text: "..."}` so callers can hand us
      // human-friendly prompts without shaping the wire format.
      const wrapped =
        typeof message === "string" ? { type: "text", text: message } : message
      for await (const evt of rt.agentSession.send(wrapped)) {
        projectEvent(rt, evt)
      }
    } catch (err) {
      rt.desc.status = "error"
      rt.desc.endedAt = new Date().toISOString()
      appendLine(
        rt,
        `[turn error] ${err instanceof Error ? err.message : String(err)}`,
        "stderr"
      )
      schedulePersist()
    } finally {
      rt.busy = false
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
      })
      input.child.once("error", err => {
        desc.status = "error"
        desc.endedAt = new Date().toISOString()
        appendLine(rt, `[child error] ${err.message}`, "stderr")
        rt.emitter.emit("status", desc.status)
        schedulePersist()
      })
      schedulePersist()
      return desc
    },
    spawnAgent(input) {
      const id = `sess_${randomUUID().slice(0, 8)}`
      const desc: SessionDescriptor = {
        id,
        kind: "agent-cli",
        workspaceSlug: input.workspaceSlug,
        command: input.commandPreview ?? `${input.adapterSlug} (agent)`,
        pid: null,
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
        schedulePersist()
      })
      schedulePersist()
      return desc
    },
    async sendPrompt(id, message) {
      const rt = validateAgentTurn(id, "sendPrompt")
      await runAgentTurn(rt, message)
    },
    enqueuePrompt(id, message) {
      // Sync validation throws to the caller; only the actual turn
      // dispatch runs in the background. Errors during the turn land
      // in the ring buffer (via projectEvent in runAgentTurn) so the
      // SSE consumer sees them as `[error]` lines.
      const rt = validateAgentTurn(id, "enqueuePrompt")
      void runAgentTurn(rt, message).catch(() => {
        // The runAgentTurn helper already projects errors into the
        // session's ring buffer — nothing else to do here.
      })
    },
    list() {
      return Array.from(sessions.values())
        .map(s => s.desc)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    },
    get(id) {
      return sessions.get(id)?.desc
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
      if (direct) return direct.desc
      for (const rt of sessions.values()) {
        if (rt.desc.name === query) return rt.desc
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
        void rt.agentSession.close().catch(() => undefined)
      }
      if (rt.pty) {
        try {
          rt.pty.kill(signal)
        } catch {
          // pty already gone — fall through
        }
      }
      rt.child?.kill(signal)
      schedulePersist()
      return true
    },
    forget(id) {
      const rt = sessions.get(id)
      if (!rt) return false
      // Don't leak: tear down the emitter so backfill listeners stop.
      rt.emitter.removeAllListeners()
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
    // Sync flush so quick sessions (spawned + ended in less than
    // PERSIST_DEBOUNCE_MS) aren't lost. The debounced async write
    // may have been cancelled by clearTimeout above, but a 200-byte
    // sync write at shutdown is cheap and the data needs to land.
    if (persist) {
      try {
        const snapshot = {
          savedAt: nowIso,
          sessions: Array.from(sessions.values()).map(s => s.desc),
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
