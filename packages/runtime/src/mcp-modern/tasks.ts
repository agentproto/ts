/**
 * MCP `io.modelcontextprotocol/tasks` extension: projects ONE TURN of a session as a task (AIP-78 TURN-TASK).
 *
 * `agent_start` (with a prompt) and `agent_prompt` answer with a `CreateTaskResult` when the client declared the
 * extension; `tasks/get`, `tasks/update` and `tasks/cancel` then read or drive that turn. The host reserves a prompt
 * ticket (and, for `agent_start`, the session id) BEFORE the tool runs and records the task durably before the prompt
 * reaches the session. The task is bound to its ticket, not to a queue position, and to the principal that created it.
 * It is a projection only: the session stays the real handle, the work board is neither read nor written, and a task
 * never outlives its turn. The task id is an unguessable random handle resolved through an on-disk ledger, never
 * derived from a session id.
 */

import { randomBytes } from "node:crypto"
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { mintSessionId, type SessionDescriptor, type SessionsRegistry } from "../sessions.js"
import type { TurnTaskReservation } from "../turn-task-context.js"
import { BridgeError } from "./bridge.js"
import { ERR_INTERNAL, ERR_INVALID_PARAMS, ERR_MISSING_CLIENT_CAPABILITY } from "./constants.js"
import { isSessionInSubtreeScope, type HumanGate } from "./human-gate.js"

export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks"
/** `_meta` key of a `CreateTaskResult`: the real session and prompt ticket the task belongs to. */
export const TURN_TASK_META = "io.agentproto/turn-task"

/** Which tools answer with a task: a host setting, applied uniformly (AIP-78 §Extension declaration and creation). */
export type TaskToolsMode = "both" | "agent_start" | "agent_prompt"
export const DEFAULT_TASK_TOOLS_MODE: TaskToolsMode = "both"

export function taskToolsForMode(mode: TaskToolsMode): ReadonlySet<string> {
  return mode === "both" ? new Set(["agent_start", "agent_prompt"]) : new Set([mode])
}

/** Tools whose call starts a turn and can therefore answer with a task (union of every mode). */
export const TASK_TURN_TOOLS: ReadonlySet<string> = taskToolsForMode("both")

export const DEFAULT_TASK_TTL_MS = 24 * 60 * 60 * 1000
export const MAX_TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const DEFAULT_TASK_POLL_INTERVAL_MS = 2000
/** Cap on the final text stored in the ledger result (the head of the turn's final text, never a transcript). */
export const TASK_RESULT_TEXT_CAP = 8 * 1024
/** Cap on the non-terminal tasks one principal may hold at once. */
export const DEFAULT_MAX_ACTIVE_TASKS_PER_PRINCIPAL = 32

const TASK_ID_RE = /^task_[0-9a-f]{32}$/

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

export type TaskStatus = "working" | "input_required" | "completed" | "cancelled" | "failed"
const isTerminal = (s: TaskStatus): boolean => s === "completed" || s === "cancelled" || s === "failed"

/** How the turn of a ticket ended (AIP-78 §Terms): a closed enumeration. */
export type TurnOutcome =
  | "finished"
  | "interrupted"
  | "dropped"
  | "session-error"
  | "session-killed"
  | "session-exited"
  | "session-forgotten"
  | "host-restart"

export interface TaskError {
  code: number
  message: string
  data?: unknown
}

/** The result of a completed turn, identical for `agent_start` and `agent_prompt`. */
export interface TurnResult {
  sessionId: string
  /** Final assistant text of the turn, bounded and redacted. */
  text: string
  /** True when `text` was cut at the bound. */
  truncated: boolean
}

export interface TurnTaskLedgerEntry {
  taskId: string
  sessionId: string
  /** Prompt ticket: stable identity of the prompt this task follows (never a queue position). */
  promptId: string
  /** Resolved server-side principal that created the task: `session:<id>`, or `operator`. */
  principal: string
  /** Daemon boot that created the entry. */
  bootId: string
  createdAt: string
  ttlMs: number
  pollIntervalMs: number
  lastStatus: TaskStatus
  statusMessage?: string
  lastUpdatedAt: string
  /** True once the ticket's turn began (or was steered into a running one): decides `failed` vs `cancelled`. */
  started: boolean
  /** Set with the terminal state; `ttlMs` counts from here. */
  endedAt?: string
  outcome?: TurnOutcome
  result?: TurnResult
  error?: TaskError
}

export interface TurnTaskLedger {
  /** Durably write a new entry (atomic, fsynced, 0600). Throws when it cannot. */
  create(entry: TurnTaskLedgerEntry): void
  get(taskId: string): TurnTaskLedgerEntry | undefined
  save(entry: TurnTaskLedgerEntry): void
  list(): TurnTaskLedgerEntry[]
  /** Non-terminal entries created by `principal`. */
  countActive(principal: string): number
  /** Drop terminal entries whose `ttlMs` elapsed since `endedAt`; never a non-terminal one. Returns the dropped ids. */
  sweep(): string[]
}

export function defaultTurnTaskLedgerDir(): string {
  return join(homedir(), ".agentproto", "mcp-tasks")
}

export function createTurnTaskLedger(opts: { dir?: string; now?: () => number } = {}): TurnTaskLedger {
  const dir = opts.dir ?? defaultTurnTaskLedgerDir()
  const now = opts.now ?? (() => Date.now())
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const fileOf = (taskId: string): string => join(dir, `${taskId}.json`)
  let tmpSeq = 0

  const expired = (e: TurnTaskLedgerEntry): boolean =>
    isTerminal(e.lastStatus) && e.endedAt !== undefined && Date.parse(e.endedAt) + e.ttlMs <= now()

  const parse = (taskId: string): TurnTaskLedgerEntry | undefined => {
    if (!TASK_ID_RE.test(taskId)) return undefined
    try {
      const parsed = JSON.parse(readFileSync(fileOf(taskId), "utf8")) as unknown
      if (
        !isRecord(parsed) ||
        parsed.taskId !== taskId ||
        typeof parsed.sessionId !== "string" ||
        typeof parsed.promptId !== "string" ||
        typeof parsed.principal !== "string"
      ) {
        return undefined
      }
      return parsed as unknown as TurnTaskLedgerEntry
    } catch {
      return undefined
    }
  }

  /** Write to a temporary file in the same directory, fsync, rename, then fsync the directory: all or nothing. */
  const write = (entry: TurnTaskLedgerEntry): void => {
    const path = fileOf(entry.taskId)
    const tmp = `${path}.${process.pid}.${tmpSeq++}.tmp`
    const fd = openSync(tmp, "w", 0o600)
    try {
      writeSync(fd, JSON.stringify(entry))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
    try {
      const dirFd = openSync(dir, "r")
      try {
        fsyncSync(dirFd)
      } finally {
        closeSync(dirFd)
      }
    } catch {
      // directory fsync is not available everywhere; the rename itself is already atomic
    }
  }

  // The directory is read once; afterwards the map is the source of truth and every change is written through.
  const cache = new Map<string, TurnTaskLedgerEntry>()
  try {
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".tmp")) {
        rmSync(join(dir, name), { force: true }) // an interrupted write: the rename never happened
        continue
      }
      if (!name.endsWith(".json")) continue
      const entry = parse(name.slice(0, -".json".length))
      if (entry) cache.set(entry.taskId, entry)
    }
  } catch {
    // an unreadable directory simply starts empty
  }

  const sweep = (): string[] => {
    const dropped: string[] = []
    for (const entry of [...cache.values()]) {
      if (!expired(entry)) continue
      rmSync(fileOf(entry.taskId), { force: true })
      cache.delete(entry.taskId)
      dropped.push(entry.taskId)
    }
    return dropped
  }
  sweep()

  const put = (entry: TurnTaskLedgerEntry): void => {
    write(entry)
    cache.set(entry.taskId, entry)
  }

  return {
    create: put,
    save: put,
    get(taskId) {
      const entry = cache.get(taskId)
      if (!entry) return undefined
      if (expired(entry)) {
        sweep()
        return undefined
      }
      return entry
    },
    list: () => [...cache.values()].filter(e => !expired(e)),
    countActive(principal) {
      let n = 0
      for (const e of cache.values()) if (e.principal === principal && !isTerminal(e.lastStatus)) n++
      return n
    },
    sweep,
  }
}

export function mintTaskId(): string {
  return `task_${randomBytes(16).toString("hex")}`
}

export function mintPromptId(): string {
  return `prompt_${randomBytes(8).toString("hex")}`
}

/** True when `_meta["io.modelcontextprotocol/clientCapabilities"].extensions` carries the Tasks extension. */
export function clientDeclaresTasks(clientCapabilities: Record<string, unknown> | undefined): boolean {
  const extensions = clientCapabilities?.extensions
  return isRecord(extensions) && isRecord(extensions[TASKS_EXTENSION])
}

/** The principal of a request: the verified caller session, else the operator. Never read from a client field. */
export const principalOf = (callerSessionId: string | undefined): string =>
  callerSessionId !== undefined ? `session:${callerSessionId}` : "operator"

// ── Projection ─────────────────────────────────────────────────────────────

export type TaskSessions = Pick<
  SessionsRegistry,
  "get" | "readOutputTail" | "onPromptTicket" | "onSessionRetired" | "promptTicketState" | "cancelPromptTicket"
>

export interface TaskProjectorOptions {
  sessions: TaskSessions
  ledger: TurnTaskLedger
  /** Source of `input_required` (parked permissions and questions) and of the resolution on `tasks/update`. */
  humanGate?: Pick<HumanGate, "inspectPendingForSession" | "applyResponsesForSession">
  /** Last assistant text of a session (transcript), preferred over the live output ring. */
  readFinalText?: (sessionId: string) => string | undefined
  /** Scrubs secrets the host holds from the text before it is stored. Always applied. */
  redact?: (text: string) => string
  now?: () => number
  bootId?: string
  /** Which tools answer with a task (default: `agent_start` and `agent_prompt`). */
  tools?: ReadonlySet<string>
  /** Retention applied to every task, clamped to `maxTtlMs`. */
  ttlMs?: number
  maxTtlMs?: number
  pollIntervalMs?: number
  /** Bound on the stored result text. */
  resultMaxChars?: number
  /** Cap on non-terminal tasks per principal. */
  maxActivePerPrincipal?: number
}

/** What the host decided for a covered tool call before running it. */
export type TurnTaskPlan =
  | { kind: "refused"; answer: Record<string, unknown> }
  | { kind: "reserved"; tool: string; taskId: string; reservation: TurnTaskReservation }

export interface TaskProjector {
  /**
   * Decide, BEFORE the tool runs, whether this call becomes a task. A call that is not covered, or whose client did
   * not declare the extension (the caller checks that), returns undefined. A refusal (per-principal cap) is returned
   * as the tool error to answer with: nothing was created.
   */
  plan(tool: string, params: Record<string, unknown>, callerSessionId: string | undefined): TurnTaskPlan | undefined
  /** Replace the host settings (which tools answer with a task, retention, caps) for the requests that follow. */
  configure(next: {
    tools?: TaskToolsMode
    ttlMs?: number
    maxTtlMs?: number
    maxActivePerPrincipal?: number
    resultMaxChars?: number
  }): void
  /** After the tool ran: turn a successful turn-starting answer into a `CreateTaskResult`; any other answer is returned as is. */
  finalize(plan: TurnTaskPlan, answer: Record<string, unknown>): Record<string, unknown>
  get(
    taskId: string,
    callerSessionId: string | undefined,
    clientCapabilities: Record<string, unknown> | undefined,
  ): Record<string, unknown>
  update(
    taskId: string,
    callerSessionId: string | undefined,
    inputResponses: Record<string, unknown>,
    clientCapabilities: Record<string, unknown> | undefined,
  ): Promise<void>
  cancel(taskId: string, callerSessionId: string | undefined): Promise<void>
  /** Bus hook: a session ended (exit, kill, error): settle the tasks it can no longer serve. */
  observeSessionEnded(sessionId: string): void
  /** Bus hook: a pending permission or question of the session appeared or was answered. */
  observeInputChanged(sessionId: string): void
}

const unknownTask = (): BridgeError => new BridgeError(ERR_INVALID_PARAMS, "Unknown or expired taskId", undefined, 400)

const toolError = (text: string): Record<string, unknown> => ({ content: [{ type: "text", text }], isError: true })

function bodyOf(answer: Record<string, unknown>): Record<string, unknown> | undefined {
  const content = answer.content
  if (!Array.isArray(content)) return undefined
  const first = content.find((c): c is Record<string, unknown> => isRecord(c) && typeof c.text === "string")
  if (!first) return undefined
  try {
    const parsed = JSON.parse(first.text as string) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function errorText(answer: Record<string, unknown>): string {
  const content = answer.content
  if (Array.isArray(content)) {
    const first = content.find((c): c is Record<string, unknown> => isRecord(c) && typeof c.text === "string")
    if (first) return (first.text as string).slice(0, 500)
  }
  return "The tool call failed"
}

export function createTaskProjector(opts: TaskProjectorOptions): TaskProjector {
  const { sessions, ledger, humanGate } = opts
  const now = opts.now ?? (() => Date.now())
  const bootId = opts.bootId ?? randomBytes(8).toString("hex")
  // Host settings; `configure` replaces them between requests (a `config_set` applies at once).
  const settings = {
    tools: opts.tools ?? TASK_TURN_TOOLS,
    ttlMs: opts.ttlMs ?? DEFAULT_TASK_TTL_MS,
    maxTtlMs: opts.maxTtlMs ?? MAX_TASK_TTL_MS,
    pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_TASK_POLL_INTERVAL_MS,
    resultMaxChars: opts.resultMaxChars ?? TASK_RESULT_TEXT_CAP,
    maxActive: opts.maxActivePerPrincipal ?? DEFAULT_MAX_ACTIVE_TASKS_PER_PRINCIPAL,
  }
  /** Retention of a new task: always a finite number, host default clamped to the host maximum. */
  const retentionMs = (): number => Math.max(1, Math.min(settings.ttlMs, settings.maxTtlMs))
  const redact = opts.redact ?? ((text: string) => text)

  /** ISO instant, never earlier than (nor equal to) the entry's previous `lastUpdatedAt`: monotonic per task. */
  const stamp = (prev?: string): string => {
    const prevMs = prev ? Date.parse(prev) : Number.NEGATIVE_INFINITY
    return new Date(Math.max(now(), prevMs + 1)).toISOString()
  }

  /** Non-terminal entries by ticket, for the event hooks. */
  const activeByPrompt = new Map<string, string>()
  const index = (e: TurnTaskLedgerEntry): void => {
    if (isTerminal(e.lastStatus)) activeByPrompt.delete(e.promptId)
    else activeByPrompt.set(e.promptId, e.taskId)
  }
  const activeOfSession = (sessionId: string): TurnTaskLedgerEntry[] => {
    const out: TurnTaskLedgerEntry[] = []
    for (const taskId of activeByPrompt.values()) {
      const e = ledger.get(taskId)
      if (e && e.sessionId === sessionId && !isTerminal(e.lastStatus)) out.push(e)
    }
    return out
  }

  const save = (entry: TurnTaskLedgerEntry): TurnTaskLedgerEntry => {
    ledger.save(entry)
    index(entry)
    return entry
  }

  const finalText = (sessionId: string): TurnResult => {
    let raw = ""
    try {
      const text = opts.readFinalText?.(sessionId)
      if (typeof text === "string" && text.length > 0) raw = text
    } catch {
      // fall through to the output ring
    }
    if (raw.length === 0) {
      try {
        // eslint-disable-next-line no-control-regex
        raw = sessions.readOutputTail(sessionId, 60).join("\n").replace(/\u001b\[[0-9;]*m/g, "")
      } catch {
        raw = ""
      }
    }
    // Redact BEFORE cutting, so a secret straddling the bound is not left half-visible.
    let text = redact(raw)
    const truncated = text.length > settings.resultMaxChars
    if (truncated) text = text.slice(0, settings.resultMaxChars)
    return { sessionId, text, truncated }
  }

  /** Move the entry to a terminal state once and record it; an entry already terminal keeps its first outcome. */
  const settle = (
    entry: TurnTaskLedgerEntry,
    status: "completed" | "cancelled" | "failed",
    outcome: TurnOutcome | undefined,
    extra: { result?: TurnResult; error?: TaskError; statusMessage?: string } = {},
  ): TurnTaskLedgerEntry => {
    const current = ledger.get(entry.taskId) ?? entry
    if (isTerminal(current.lastStatus)) return current
    const at = stamp(current.lastUpdatedAt)
    const next: TurnTaskLedgerEntry = {
      ...current,
      lastStatus: status,
      lastUpdatedAt: at,
      endedAt: at,
      ...(outcome !== undefined ? { outcome } : {}),
      ...(extra.result ? { result: extra.result } : {}),
      ...(extra.error ? { error: extra.error } : {}),
    }
    // A terminal task drops the live phase ("thinking"); only an explicit message survives.
    if (extra.statusMessage !== undefined) next.statusMessage = extra.statusMessage
    else delete next.statusMessage
    return save(next)
  }

  const failedError = (reason: string, entry: TurnTaskLedgerEntry, extra: Record<string, unknown> = {}): TaskError => ({
    code: ERR_INTERNAL,
    message:
      reason === "host-restart"
        ? "The host restarted before the turn ended"
        : `The session ended abnormally during the turn (${reason})`,
    data: { reason, sessionId: entry.sessionId, ...extra },
  })

  /** AIP-78 §Turn-to-task state mapping, rows for a session that is gone or ended. */
  const settleForSessionEnd = (
    entry: TurnTaskLedgerEntry,
    cause: "session-error" | "session-killed" | "session-exited" | "session-forgotten" | "host-restart",
    extra: Record<string, unknown> = {},
  ): TurnTaskLedgerEntry => {
    if (cause === "host-restart") {
      return settle(entry, "failed", "host-restart", { error: failedError("host-restart", entry, extra) })
    }
    if (cause === "session-killed") return settle(entry, "cancelled", cause, { statusMessage: "session stopped" })
    if (!entry.started) return settle(entry, "cancelled", cause, { statusMessage: "no work was done" })
    return settle(entry, "failed", cause, { error: failedError(cause, entry, extra) })
  }

  /** Terminal outcome implied by the session's own status, if it is over. */
  const settleFromSessionStatus = (entry: TurnTaskLedgerEntry, desc: SessionDescriptor): TurnTaskLedgerEntry | undefined => {
    if (desc.status === "killed") {
      return desc.endedReason === "daemon-restart"
        ? settleForSessionEnd(entry, "host-restart")
        : settleForSessionEnd(entry, "session-killed")
    }
    if (desc.status === "exited") {
      return settleForSessionEnd(entry, "session-exited", desc.exitCode !== undefined ? { exitCode: desc.exitCode } : {})
    }
    if (desc.status === "error") return settleForSessionEnd(entry, "session-error")
    return undefined
  }

  // The ticket events the registry reports: the ONLY writer of a turn's end (the state is recorded when the turn ends,
  // never when a client happens to read).
  sessions.onPromptTicket(ev => {
    const taskId = activeByPrompt.get(ev.promptId)
    const entry = taskId ? ledger.get(taskId) : undefined
    if (!entry || entry.sessionId !== ev.sessionId || isTerminal(entry.lastStatus)) return
    switch (ev.type) {
      case "started":
      case "steered": {
        const { statusMessage: _queued, ...rest } = entry
        save({
          ...rest,
          started: true,
          lastStatus: "working",
          lastUpdatedAt: stamp(entry.lastUpdatedAt),
          ...(ev.type === "steered" ? { statusMessage: "steered into the running turn" } : {}),
        })
        return
      }
      case "dropped":
        settle(entry, "cancelled", "dropped", {
          statusMessage:
            ev.cause === "answered-question"
              ? "the prompt answered a pending question"
              : ev.cause === "superseded"
                ? "the first turn ran under a different prompt"
                : "removed from the queue",
        })
        return
      case "ended": {
        const desc = sessions.get(ev.sessionId)
        const fromStatus = desc ? settleFromSessionStatus({ ...entry, started: true }, desc) : undefined
        if (fromStatus) return
        if (ev.interrupted) {
          settle(entry, "cancelled", "interrupted", { statusMessage: "interrupted" })
          return
        }
        settle(entry, "completed", "finished", { result: finalText(ev.sessionId) })
      }
    }
  })

  sessions.onSessionRetired(ev => {
    if (ev.cause !== "forgotten") return
    for (const entry of activeOfSession(ev.sessionId)) settleForSessionEnd(entry, "session-forgotten")
  })

  // A ledger left by an earlier boot: a task with no recorded terminal state cannot be followed any more.
  for (const entry of ledger.list()) {
    if (isTerminal(entry.lastStatus)) continue
    if (entry.bootId !== bootId) settleForSessionEnd(entry, "host-restart")
    else index(entry)
  }

  const taskBase = (entry: TurnTaskLedgerEntry, status: TaskStatus, statusMessage: string | undefined): Record<string, unknown> => ({
    taskId: entry.taskId,
    status,
    ...(statusMessage !== undefined ? { statusMessage } : {}),
    createdAt: entry.createdAt,
    lastUpdatedAt: entry.lastUpdatedAt,
    ttlMs: entry.ttlMs,
    pollIntervalMs: entry.pollIntervalMs,
  })

  /** Resolve the entry for a caller; unknown, expired and foreign ids are indistinguishable. */
  const resolve = (taskId: string, callerSessionId: string | undefined): TurnTaskLedgerEntry => {
    ledger.sweep()
    const entry = ledger.get(taskId)
    if (!entry) throw unknownTask()
    if (entry.principal === principalOf(callerSessionId)) return entry
    // Not the creator: allowed only where the session rules let the caller act on the underlying session
    // (the operator, or a session supervising it).
    if (!isSessionInSubtreeScope(sessions, callerSessionId, entry.sessionId)) throw unknownTask()
    return entry
  }

  /** Non-terminal state read from the session, without writing anything. */
  const liveView = (
    entry: TurnTaskLedgerEntry,
    callerSessionId: string | undefined,
    clientCapabilities: Record<string, unknown> | undefined,
  ): { status: TaskStatus; statusMessage?: string; inputRequests?: Record<string, unknown> } => {
    const desc = sessions.get(entry.sessionId)
    const ticket = sessions.promptTicketState(entry.sessionId, entry.promptId)
    if (ticket !== "in-flight") {
      return { status: "working", statusMessage: "queued" }
    }
    if (humanGate) {
      const pending = humanGate.inspectPendingForSession(entry.sessionId, callerSessionId, clientCapabilities)
      if (pending && Object.keys(pending).length > 0) {
        return { status: "input_required", statusMessage: "awaiting-input", inputRequests: pending }
      }
    }
    const phase = typeof desc?.currentPhase === "string" ? desc.currentPhase : undefined
    return { status: "working", ...(phase !== undefined ? { statusMessage: phase } : {}) }
  }

  /** Bring a non-terminal entry up to date with what the session shows (the events normally got there first). */
  const reconcile = (entry: TurnTaskLedgerEntry): TurnTaskLedgerEntry => {
    if (isTerminal(entry.lastStatus)) return entry
    if (entry.bootId !== bootId) return settleForSessionEnd(entry, "host-restart")
    const desc = sessions.get(entry.sessionId)
    if (!desc) return entry.started ? settleForSessionEnd(entry, "session-forgotten") : entry
    return settleFromSessionStatus(entry, desc) ?? entry
  }

  // Cancels are serialized per session, so two of them never interleave on the same session.
  const chains = new Map<string, Promise<unknown>>()
  const serial = <T>(sessionId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = chains.get(sessionId) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.catch(() => undefined)
    chains.set(sessionId, tail)
    void tail.then(() => {
      if (chains.get(sessionId) === tail) chains.delete(sessionId)
    })
    return run
  }

  return {
    configure(next) {
      settings.tools = taskToolsForMode(next.tools ?? "both")
      settings.ttlMs = next.ttlMs ?? opts.ttlMs ?? DEFAULT_TASK_TTL_MS
      settings.maxTtlMs = next.maxTtlMs ?? opts.maxTtlMs ?? MAX_TASK_TTL_MS
      settings.maxActive = next.maxActivePerPrincipal ?? opts.maxActivePerPrincipal ?? DEFAULT_MAX_ACTIVE_TASKS_PER_PRINCIPAL
      settings.resultMaxChars = next.resultMaxChars ?? opts.resultMaxChars ?? TASK_RESULT_TEXT_CAP
    },
    plan(tool, params, callerSessionId) {
      if (!settings.tools.has(tool)) return undefined
      const args = isRecord(params.arguments) ? params.arguments : {}
      if (tool === "agent_start") {
        const prompt = args.prompt
        const hasPrompt = typeof prompt === "string" ? prompt.trim().length > 0 : prompt !== undefined && prompt !== null
        // Without a first prompt there is no turn to project: the ordinary answer stands.
        if (!hasPrompt) return undefined
      }
      const principal = principalOf(callerSessionId)
      // Checked BEFORE anything exists: a refused call leaves no ticket, ledger entry or turn behind.
      if (ledger.countActive(principal) >= settings.maxActive) {
        return {
          kind: "refused",
          answer: toolError(
            `${tool}: too many tasks still running for this caller (limit ${settings.maxActive}). Wait for one to end or cancel it, then retry.`,
          ),
        }
      }
      const taskId = mintTaskId()
      const promptId = mintPromptId()
      const sessionId = tool === "agent_start" ? mintSessionId() : undefined
      let committed = false
      const reservation: TurnTaskReservation = {
        promptId,
        ...(sessionId !== undefined ? { sessionId } : {}),
        commit(target) {
          if (committed) return
          const createdAt = new Date(now()).toISOString()
          // Durable BEFORE the prompt reaches the session: a `tasks/get` on this id must already resolve, and a crash
          // right after leaves an entry the restart rule closes, never a turn nobody can find.
          ledger.create({
            taskId,
            sessionId: target,
            promptId,
            principal,
            bootId,
            createdAt,
            ttlMs: retentionMs(),
            pollIntervalMs: settings.pollIntervalMs,
            lastStatus: "working",
            statusMessage: "queued",
            lastUpdatedAt: createdAt,
            started: false,
          })
          committed = true
          const entry = ledger.get(taskId)
          if (entry) index(entry)
        },
      }
      return { kind: "reserved", tool, taskId, reservation }
    },

    finalize(plan, answer) {
      if (plan.kind === "refused") return plan.answer
      const entry = ledger.get(plan.taskId)
      // The tool never reached its commit point (it refused or failed first): nothing to clean up.
      if (!entry) return answer
      if (answer.isError === true) {
        // Handing the prompt over failed: the entry is closed as failed and the caller gets the tool's own error.
        settle(entry, "failed", undefined, {
          error: { code: ERR_INTERNAL, message: errorText(answer), data: { reason: "tool-error" } },
        })
        return answer
      }
      if (answer.resultType === "input_required") {
        settle(entry, "cancelled", "dropped", { statusMessage: "the call is waiting for input and starts no turn" })
        return answer
      }
      const body = bodyOf(answer)
      const accepted =
        body !== undefined &&
        body.ok !== false &&
        body.duplicate !== true &&
        body.delivery !== "duplicate" &&
        // A spawn answered from an existing session (deduplicated) started nothing under the reserved id.
        (plan.tool !== "agent_start" || body.id === entry.sessionId)
      if (!accepted) {
        settle(entry, "cancelled", "dropped", { statusMessage: "the call started no turn" })
        return answer
      }
      const current = ledger.get(entry.taskId) ?? entry
      // The prompt answered a parked question: no turn exists, so no task is handed out.
      if (current.lastStatus === "cancelled" && current.outcome === "dropped") return answer
      return {
        resultType: "task",
        ...taskBase(current, current.lastStatus, current.statusMessage),
        _meta: { [TURN_TASK_META]: { sessionId: current.sessionId, promptId: current.promptId } },
      }
    },

    get(taskId, callerSessionId, clientCapabilities) {
      const entry = reconcile(resolve(taskId, callerSessionId))
      if (isTerminal(entry.lastStatus)) {
        const base = { resultType: "complete", ...taskBase(entry, entry.lastStatus, entry.statusMessage) }
        switch (entry.lastStatus) {
          case "completed":
            return { ...base, result: entry.result ?? { sessionId: entry.sessionId, text: "", truncated: false } }
          case "failed":
            return { ...base, error: entry.error ?? { code: ERR_INTERNAL, message: "The turn failed" } }
          default:
            return base
        }
      }
      // No write: reading never changes the task or the session.
      const live = liveView(entry, callerSessionId, clientCapabilities)
      const base = { resultType: "complete", ...taskBase(entry, live.status, live.statusMessage) }
      return live.status === "input_required" ? { ...base, inputRequests: live.inputRequests ?? {} } : base
    },

    async update(taskId, callerSessionId, inputResponses, clientCapabilities) {
      const entry = reconcile(resolve(taskId, callerSessionId))
      // Not waiting for input (including a terminal task): an acknowledged no-op.
      if (isTerminal(entry.lastStatus) || !humanGate) return
      if (liveView(entry, callerSessionId, clientCapabilities).status !== "input_required") return
      // The same resolvers, scoping and anti-self-approval as a direct elicitation answer: never a second judge.
      await humanGate.applyResponsesForSession(entry.sessionId, callerSessionId, inputResponses)
    },

    async cancel(taskId, callerSessionId) {
      const entry = reconcile(resolve(taskId, callerSessionId))
      if (isTerminal(entry.lastStatus)) return
      await serial(entry.sessionId, async () => {
        try {
          // Acts on THIS ticket only: queued = dropped, in flight = its turn interrupted, anything else = no effect.
          await sessions.cancelPromptTicket(entry.sessionId, entry.promptId)
        } catch (err) {
          // The harness cannot cancel a turn: the task stays as it was and the caller learns it.
          throw new BridgeError(
            ERR_INTERNAL,
            err instanceof Error ? err.message : "The turn cannot be cancelled",
            { reason: "cancel-unsupported", taskId: entry.taskId },
          )
        }
      })
    },

    observeSessionEnded(sessionId) {
      for (const entry of activeOfSession(sessionId)) reconcile(entry)
    },

    observeInputChanged(sessionId) {
      for (const entry of activeOfSession(sessionId)) {
        if (!entry.started) continue
        save({ ...entry, lastUpdatedAt: stamp(entry.lastUpdatedAt) })
      }
    },
  }
}

// ── Request handling ───────────────────────────────────────────────────────

export interface TaskRequestContext {
  method: string
  params: Record<string, unknown>
  callerSessionId?: string
  clientCapabilities?: Record<string, unknown>
}

/** Answer `tasks/get|update|cancel`. Throws `BridgeError` for protocol errors. */
export async function handleTaskRequest(
  projector: TaskProjector,
  ctx: TaskRequestContext,
): Promise<Record<string, unknown>> {
  if (!clientDeclaresTasks(ctx.clientCapabilities)) {
    throw new BridgeError(
      ERR_MISSING_CLIENT_CAPABILITY,
      "The tasks extension must be declared in _meta clientCapabilities.extensions",
      { requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } } },
    )
  }
  const taskId = ctx.params.taskId
  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new BridgeError(ERR_INVALID_PARAMS, "Missing required params.taskId", undefined, 400)
  }
  switch (ctx.method) {
    case "tasks/get":
      return projector.get(taskId, ctx.callerSessionId, ctx.clientCapabilities)
    case "tasks/update": {
      const responses = ctx.params.inputResponses
      if (!isRecord(responses)) {
        throw new BridgeError(ERR_INVALID_PARAMS, "params.inputResponses must be an object", undefined, 400)
      }
      await projector.update(taskId, ctx.callerSessionId, responses, ctx.clientCapabilities)
      return { resultType: "complete" }
    }
    default:
      await projector.cancel(taskId, ctx.callerSessionId)
      return { resultType: "complete" }
  }
}
