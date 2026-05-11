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
import { promises as fs } from "node:fs"
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
  /** Ring buffer of recent stdout+stderr lines. Capped so a runaway
   *  child can't blow the daemon's heap. */
  recentLines: string[]
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
const PERSIST_DEBOUNCE_MS = 1_500

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

export function createSessionsRegistry(opts?: {
  /** Override the persistence path — tests pin a tmpdir. */
  persistPath?: string
  /** Disable persistence entirely. */
  persist?: boolean
}): SessionsRegistry {
  const persistPath = opts?.persistPath ?? SESSIONS_FILE_PATH()
  const persist = opts?.persist ?? true
  const sessions = new Map<string, SessionRuntime>()
  let persistTimer: ReturnType<typeof setTimeout> | null = null

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
    rt.emitter.emit("line", { line, stream })
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
        ...(input.label ? { label: input.label } : {}),
      }
      const rt: SessionRuntime = {
        desc,
        child,
        recentLines: [],
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
        ...(input.label ? { label: input.label } : {}),
      }
      const rt: SessionRuntime = {
        desc,
        agentSession: input.agentSession,
        adapterSlug: input.adapterSlug,
        recentLines: [],
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
      // SIGTERM the underlying child if any. Either branch is a
      // best-effort — the descriptor flip is what the UI surfaces.
      if (rt.agentSession) {
        void rt.agentSession.close().catch(() => undefined)
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
      if (persistTimer) clearTimeout(persistTimer)
      for (const rt of sessions.values()) {
        rt.emitter.removeAllListeners()
        if (
          rt.desc.status === "running" ||
          rt.desc.status === "starting"
        ) {
          if (rt.agentSession) {
            void rt.agentSession.close().catch(() => undefined)
          }
          rt.child?.kill("SIGTERM")
        }
      }
      sessions.clear()
    },
  }
}

/** Minimal shell-quote — wraps args containing whitespace or quotes
 *  so the rendered `command` field is copy-pasteable. */
function quoteArg(arg: string): string {
  if (arg === "") return '""'
  if (/^[a-zA-Z0-9._/=:@,+-]+$/.test(arg)) return arg
  return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`
}
