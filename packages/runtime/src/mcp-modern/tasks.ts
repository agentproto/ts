/**
 * MCP `io.modelcontextprotocol/tasks` extension: projects ONE TURN of a session as a task.
 *
 * `agent_start` (first turn) and `agent_prompt` (next turn) answer with a `CreateTaskResult` when the client declared
 * the extension; `tasks/get`, `tasks/update` and `tasks/cancel` then read or drive that turn. This is a projection only:
 * the session stays the real handle (`sessionId`), the work board is neither read nor written, and a task never
 * outlives its turn. The task id is an unguessable random handle resolved through a small on-disk ledger, never
 * derived from a session id.
 */

import { randomBytes } from "node:crypto"
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { SessionDescriptor, SessionsRegistry } from "../sessions.js"
import { BridgeError } from "./bridge.js"
import { ERR_INVALID_PARAMS, ERR_MISSING_CLIENT_CAPABILITY } from "./constants.js"
import { isSessionInSubtreeScope, type HumanGate } from "./human-gate.js"

export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks"
/** Tools whose call starts a turn and can therefore answer with a task. */
export const TASK_TURN_TOOLS: ReadonlySet<string> = new Set(["agent_start", "agent_prompt"])

export const DEFAULT_TASK_TTL_MS = 24 * 60 * 60 * 1000
export const DEFAULT_TASK_POLL_INTERVAL_MS = 2000
/** Cap on the final text stored in the ledger result (the tail of the turn output, never the transcript). */
export const TASK_RESULT_TEXT_CAP = 8 * 1024

const TASK_ID_RE = /^task_[0-9a-f]{32}$/

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

export type TaskStatus = "working" | "input_required" | "completed" | "cancelled" | "failed"

export interface TaskError {
  code: number
  message: string
  data?: unknown
}

export interface TurnTaskLedgerEntry {
  taskId: string
  sessionId: string
  /** 1-based rank of the projected turn within the session. */
  turnSeq: number
  /** Session that created the task (absent = operator). */
  ownerSessionId?: string
  /** Daemon boot that created the entry (a restart loses a turn that had not finished). */
  bootId: string
  /** Id of the queued prompt, when the turn was parked behind another one (lets a cancel remove it). */
  queueId?: string
  createdAt: string
  ttlMs: number
  pollIntervalMs: number
  lastStatus: TaskStatus
  statusMessage?: string
  lastUpdatedAt: string
  /** Bounded result, written when the turn ends (stable even if the session chains another turn). */
  result?: Record<string, unknown>
  error?: TaskError
}

export interface TurnTaskLedger {
  create(entry: TurnTaskLedgerEntry): void
  get(taskId: string): TurnTaskLedgerEntry | undefined
  save(entry: TurnTaskLedgerEntry): void
  list(): TurnTaskLedgerEntry[]
  /** Drop the entries past their lifetime; returns the dropped ids. */
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

  const expired = (e: TurnTaskLedgerEntry): boolean => e.ttlMs > 0 && Date.parse(e.createdAt) + e.ttlMs <= now()

  const read = (taskId: string): TurnTaskLedgerEntry | undefined => {
    if (!TASK_ID_RE.test(taskId)) return undefined
    try {
      const parsed = JSON.parse(readFileSync(fileOf(taskId), "utf8")) as unknown
      if (!isRecord(parsed) || parsed.taskId !== taskId || typeof parsed.sessionId !== "string") return undefined
      return parsed as unknown as TurnTaskLedgerEntry
    } catch {
      return undefined
    }
  }

  const write = (entry: TurnTaskLedgerEntry): void => {
    const path = fileOf(entry.taskId)
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 })
    renameSync(tmp, path)
    try {
      chmodSync(path, 0o600)
    } catch {
      // best effort on filesystems without modes
    }
  }

  const sweep = (): string[] => {
    const dropped: string[] = []
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      return dropped
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      const entry = read(name.slice(0, -".json".length))
      if (entry && expired(entry)) {
        rmSync(fileOf(entry.taskId), { force: true })
        dropped.push(entry.taskId)
      }
    }
    return dropped
  }

  sweep()

  return {
    create: write,
    save: write,
    get(taskId) {
      const entry = read(taskId)
      if (!entry) return undefined
      if (expired(entry)) {
        rmSync(fileOf(taskId), { force: true })
        return undefined
      }
      return entry
    },
    list() {
      const out: TurnTaskLedgerEntry[] = []
      try {
        for (const name of readdirSync(dir)) {
          if (!name.endsWith(".json")) continue
          const entry = read(name.slice(0, -".json".length))
          if (entry && !expired(entry)) out.push(entry)
        }
      } catch {
        // an unreadable directory simply lists nothing
      }
      return out
    },
    sweep,
  }
}

export function mintTaskId(): string {
  return `task_${randomBytes(16).toString("hex")}`
}

/** True when `_meta["io.modelcontextprotocol/clientCapabilities"].extensions` carries the Tasks extension. */
export function clientDeclaresTasks(clientCapabilities: Record<string, unknown> | undefined): boolean {
  const extensions = clientCapabilities?.extensions
  return isRecord(extensions) && isRecord(extensions[TASKS_EXTENSION])
}

// ── Projection ─────────────────────────────────────────────────────────────

export type TaskSessions = Pick<SessionsRegistry, "get" | "readOutputTail" | "interruptSession" | "removeQueuedPrompt">

export interface TaskProjectorOptions {
  sessions: TaskSessions
  ledger: TurnTaskLedger
  /** Source of `input_required` (parked permissions and questions) and of the resolution on `tasks/update`. */
  humanGate?: Pick<HumanGate, "inspectPendingForSession" | "applyResponsesForSession">
  /** Last assistant text of a session (transcript), preferred over the live output ring. */
  readFinalText?: (sessionId: string) => string | undefined
  now?: () => number
  bootId?: string
  ttlMs?: number
  pollIntervalMs?: number
}

export interface TurnPlan {
  tool: string
  /** Rank of the turn that this call starts, computed BEFORE the call (queued prompts included). */
  turnSeq: number
  /** Known before the call (`agent_prompt`); `agent_start` learns it from its answer. */
  sessionId?: string
}

export interface TaskView {
  task: Record<string, unknown>
}

export interface TaskProjector {
  /** Decide, before forwarding, whether this call starts a turn that can become a task. */
  plan(tool: string, params: Record<string, unknown>): TurnPlan | undefined
  /** After forwarding: turn a successful turn-starting answer into a `CreateTaskResult`; any other answer is returned as is. */
  finalize(
    plan: TurnPlan,
    answer: Record<string, unknown>,
    callerSessionId: string | undefined,
  ): Record<string, unknown>
  get(
    taskId: string,
    callerSessionId: string | undefined,
    clientCapabilities: Record<string, unknown> | undefined,
  ): Record<string, unknown>
  update(taskId: string, callerSessionId: string | undefined, inputResponses: Record<string, unknown>): Promise<void>
  cancel(taskId: string, callerSessionId: string | undefined): Promise<void>
  /** Bus hook: a turn of `sessionId` ended; record the result of every task waiting on it. */
  observeTurnEnd(sessionId: string, reason: string | undefined): void
}

const unknownTask = (): BridgeError => new BridgeError(ERR_INVALID_PARAMS, "Unknown or expired taskId")

function textOfAnswer(answer: Record<string, unknown>): Record<string, unknown> | undefined {
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

function tailOf(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(text.length - cap)
}

export function createTaskProjector(opts: TaskProjectorOptions): TaskProjector {
  const { sessions, ledger, humanGate } = opts
  const now = opts.now ?? (() => Date.now())
  const bootId = opts.bootId ?? randomBytes(8).toString("hex")
  const ttlMs = opts.ttlMs ?? DEFAULT_TASK_TTL_MS
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_TASK_POLL_INTERVAL_MS
  const iso = (): string => new Date(now()).toISOString()

  const queueDepth = (desc: SessionDescriptor): number => desc.promptQueue?.length ?? 0

  const finalText = (sessionId: string): string => {
    try {
      const text = opts.readFinalText?.(sessionId)
      if (typeof text === "string" && text.length > 0) return tailOf(text, TASK_RESULT_TEXT_CAP)
    } catch {
      // fall through to the output ring
    }
    try {
      // eslint-disable-next-line no-control-regex
      const plain = sessions.readOutputTail(sessionId, 60).join("\n").replace(/\u001b\[[0-9;]*m/g, "")
      return tailOf(plain, TASK_RESULT_TEXT_CAP)
    } catch {
      return ""
    }
  }

  const completedResult = (sessionId: string, turnSeq: number, isError: boolean): Record<string, unknown> => ({
    content: [{ type: "text", text: finalText(sessionId) }],
    structuredContent: { sessionId, turnSeq },
    ...(isError ? { isError: true } : {}),
  })

  /** Move the entry to a terminal state once; later calls keep the first recorded outcome. */
  const settle = (
    entry: TurnTaskLedgerEntry,
    status: "completed" | "cancelled" | "failed",
    extra: { result?: Record<string, unknown>; error?: TaskError; statusMessage?: string },
  ): TurnTaskLedgerEntry => {
    if (entry.lastStatus === "completed" || entry.lastStatus === "cancelled" || entry.lastStatus === "failed") return entry
    const next: TurnTaskLedgerEntry = {
      ...entry,
      lastStatus: status,
      lastUpdatedAt: iso(),
      ...(extra.result ? { result: extra.result } : {}),
      ...(extra.error ? { error: extra.error } : {}),
    }
    // A terminal task drops the live phase ("thinking"); only an explicit message survives.
    if (extra.statusMessage !== undefined) next.statusMessage = extra.statusMessage
    else delete next.statusMessage
    ledger.save(next)
    return next
  }

  const isTerminal = (s: TaskStatus): boolean => s === "completed" || s === "cancelled" || s === "failed"

  /** Terminal outcome of the turn when the descriptor shows it is over, else undefined. */
  const settleFromDescriptor = (
    entry: TurnTaskLedgerEntry,
    desc: SessionDescriptor,
    reasonHint: string | undefined,
  ): TurnTaskLedgerEntry | undefined => {
    const turns = desc.turnsCompleted ?? 0
    if (turns >= entry.turnSeq) {
      const reason = reasonHint ?? (turns === entry.turnSeq ? desc.lastTurnReason : undefined)
      if (reason === "cancelled" || reason === "aborted") {
        return settle(entry, "cancelled", { statusMessage: "interrupted" })
      }
      return settle(entry, "completed", { result: completedResult(entry.sessionId, entry.turnSeq, reason === "error") })
    }
    const status = desc.status
    if (status === "exited" || status === "error" || status === "killed") {
      const endedReason = desc.endedReason
      if (status === "killed" && endedReason === "daemon-restart") {
        return settle(entry, "failed", {
          error: {
            code: -32603,
            message: "The daemon restarted during the turn",
            data: { sessionId: entry.sessionId, endedReason },
          },
        })
      }
      if (status === "killed") {
        if (endedReason === "operator-completed" || endedReason === "steward-completed") {
          return settle(entry, "completed", { result: completedResult(entry.sessionId, entry.turnSeq, false) })
        }
        return settle(entry, "cancelled", { statusMessage: "session stopped" })
      }
      return settle(entry, "failed", {
        error: {
          code: -32603,
          message: "The session ended abnormally during the turn",
          data: { sessionId: entry.sessionId, ...(endedReason ? { endedReason } : {}) },
        },
      })
    }
    // A turn created in an earlier daemon boot that is neither running nor queued was lost with that boot.
    if (entry.bootId !== bootId && !desc.busy && queueDepth(desc) === 0) {
      return settle(entry, "failed", {
        error: {
          code: -32603,
          message: "The daemon restarted during the turn",
          data: { sessionId: entry.sessionId, endedReason: "daemon-restart" },
        },
      })
    }
    return undefined
  }

  const taskBase = (entry: TurnTaskLedgerEntry): Record<string, unknown> => ({
    taskId: entry.taskId,
    status: entry.lastStatus,
    ...(entry.statusMessage !== undefined ? { statusMessage: entry.statusMessage } : {}),
    createdAt: entry.createdAt,
    lastUpdatedAt: entry.lastUpdatedAt,
    ttlMs: entry.ttlMs,
    pollIntervalMs: entry.pollIntervalMs,
  })

  /** Resolve the entry for a caller; unknown, expired and foreign ids are indistinguishable. */
  const resolve = (taskId: string, callerSessionId: string | undefined): TurnTaskLedgerEntry => {
    const entry = ledger.get(taskId)
    if (!entry) throw unknownTask()
    if (callerSessionId !== undefined) {
      const owner = entry.ownerSessionId === callerSessionId
      if (!owner && !isSessionInSubtreeScope(sessions, callerSessionId, entry.sessionId)) throw unknownTask()
    }
    return entry
  }

  /** Current non-terminal state, recorded in the ledger only when it changed. */
  const liveState = (
    entry: TurnTaskLedgerEntry,
    desc: SessionDescriptor,
    callerSessionId: string | undefined,
    clientCapabilities: Record<string, unknown> | undefined,
  ): { entry: TurnTaskLedgerEntry; inputRequests?: Record<string, unknown> } => {
    const turns = desc.turnsCompleted ?? 0
    let status: TaskStatus = "working"
    let statusMessage: string | undefined
    let inputRequests: Record<string, unknown> | undefined
    if (turns + (desc.busy ? 1 : 0) < entry.turnSeq) {
      statusMessage = "queued"
    } else {
      statusMessage = typeof desc.currentPhase === "string" ? desc.currentPhase : undefined
      if (desc.awaitingPermission && humanGate) {
        const pending = humanGate.inspectPendingForSession(entry.sessionId, callerSessionId, clientCapabilities)
        if (pending && Object.keys(pending).length > 0) {
          status = "input_required"
          inputRequests = pending
          statusMessage = "awaiting-input"
        }
      }
    }
    if (entry.lastStatus === status && entry.statusMessage === statusMessage) {
      return { entry, ...(inputRequests ? { inputRequests } : {}) }
    }
    const next: TurnTaskLedgerEntry = {
      ...entry,
      lastStatus: status,
      lastUpdatedAt: iso(),
      ...(statusMessage !== undefined ? { statusMessage } : {}),
    }
    if (statusMessage === undefined) delete next.statusMessage
    ledger.save(next)
    return { entry: next, ...(inputRequests ? { inputRequests } : {}) }
  }

  return {
    plan(tool, params) {
      if (!TASK_TURN_TOOLS.has(tool)) return undefined
      const args = isRecord(params.arguments) ? params.arguments : {}
      if (tool === "agent_start") {
        const prompt = args.prompt
        const hasPrompt = typeof prompt === "string" ? prompt.trim().length > 0 : prompt !== undefined && prompt !== null
        // Without a first prompt there is no turn to project: the ordinary answer stands.
        return hasPrompt ? { tool, turnSeq: 1 } : undefined
      }
      const sessionId = typeof args.sessionId === "string" ? args.sessionId : typeof args.id === "string" ? args.id : undefined
      const desc = sessionId ? sessions.get(sessionId) : undefined
      if (!desc) return { tool, turnSeq: -1 }
      const interrupt = args.interrupt === true
      const base = (desc.turnsCompleted ?? 0) + (desc.busy ? 1 : 0)
      // An interrupt aborts the running turn (it counts as completed) and drops the queue behind it.
      const rank = interrupt ? base + 1 : base + queueDepth(desc) + 1
      return { tool, turnSeq: rank, sessionId: desc.id }
    },

    finalize(plan, answer, callerSessionId) {
      if (answer.isError === true || answer.resultType === "input_required") return answer
      const body = textOfAnswer(answer)
      if (!body) return answer
      const sessionId =
        plan.tool === "agent_start"
          ? typeof body.id === "string"
            ? body.id
            : undefined
          : typeof body.sessionId === "string"
            ? body.sessionId
            : plan.sessionId
      if (!sessionId || body.duplicate === true || body.ok === false) return answer
      let turnSeq = plan.turnSeq
      if (turnSeq < 1) {
        const desc = sessions.get(sessionId)
        turnSeq = (desc?.turnsCompleted ?? 0) + (desc?.busy ? 1 : 0) || 1
      }
      const createdAt = iso()
      const queueId = typeof body.queueId === "string" ? body.queueId : undefined
      const entry: TurnTaskLedgerEntry = {
        taskId: mintTaskId(),
        sessionId,
        turnSeq,
        ...(callerSessionId !== undefined ? { ownerSessionId: callerSessionId } : {}),
        bootId,
        ...(queueId ? { queueId } : {}),
        createdAt,
        ttlMs,
        pollIntervalMs,
        lastStatus: "working",
        lastUpdatedAt: createdAt,
      }
      // Durable BEFORE the answer leaves: a `tasks/get` on this id must already resolve.
      ledger.create(entry)
      return { resultType: "task", ...taskBase(entry) }
    },

    get(taskId, callerSessionId, clientCapabilities) {
      ledger.sweep()
      let entry = resolve(taskId, callerSessionId)
      const desc = sessions.get(entry.sessionId)
      if (!isTerminal(entry.lastStatus)) {
        if (!desc) throw unknownTask()
        const settled = settleFromDescriptor(entry, desc, undefined)
        if (settled) entry = settled
        else entry = liveState(entry, desc, callerSessionId, clientCapabilities).entry
      }
      const base = { resultType: "complete", ...taskBase(entry) }
      switch (entry.lastStatus) {
        case "completed":
          return { ...base, result: entry.result ?? completedResult(entry.sessionId, entry.turnSeq, false) }
        case "failed":
          return { ...base, error: entry.error ?? { code: -32603, message: "The turn failed" } }
        case "input_required": {
          const requests = desc
            ? liveState(entry, desc, callerSessionId, clientCapabilities).inputRequests
            : undefined
          return { ...base, inputRequests: requests ?? {} }
        }
        default:
          return base
      }
    },

    async update(taskId, callerSessionId, inputResponses) {
      const entry = resolve(taskId, callerSessionId)
      if (isTerminal(entry.lastStatus) || !humanGate) return
      // The same resolvers, scoping and anti-self-approval as a direct elicitation answer: never a second judge.
      await humanGate.applyResponsesForSession(entry.sessionId, callerSessionId, inputResponses)
    },

    async cancel(taskId, callerSessionId) {
      const entry = resolve(taskId, callerSessionId)
      if (isTerminal(entry.lastStatus)) return
      const desc = sessions.get(entry.sessionId)
      if (!desc) return
      const turns = desc.turnsCompleted ?? 0
      if (turns >= entry.turnSeq) return
      if (turns + (desc.busy ? 1 : 0) >= entry.turnSeq) {
        // The turn is the one running: cooperative stop, the session stays alive.
        await sessions.interruptSession(entry.sessionId)
        return
      }
      // Still queued behind another turn: remove only this prompt, never interrupt someone else's turn.
      if (entry.queueId) {
        const removed = sessions.removeQueuedPrompt(entry.sessionId, entry.queueId)
        if (removed.removed) settle(entry, "cancelled", { statusMessage: "removed from the queue" })
      }
    },

    observeTurnEnd(sessionId, reason) {
      const desc = sessions.get(sessionId)
      if (!desc) return
      const turns = desc.turnsCompleted ?? 0
      for (const entry of ledger.list()) {
        if (entry.sessionId !== sessionId || isTerminal(entry.lastStatus) || entry.turnSeq > turns) continue
        settleFromDescriptor(entry, desc, entry.turnSeq === turns ? reason : undefined)
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
    throw new BridgeError(ERR_INVALID_PARAMS, "Missing required params.taskId")
  }
  switch (ctx.method) {
    case "tasks/get":
      return projector.get(taskId, ctx.callerSessionId, ctx.clientCapabilities)
    case "tasks/update": {
      const responses = ctx.params.inputResponses
      if (!isRecord(responses)) throw new BridgeError(ERR_INVALID_PARAMS, "params.inputResponses must be an object")
      await projector.update(taskId, ctx.callerSessionId, responses)
      return { resultType: "complete" }
    }
    default:
      await projector.cancel(taskId, ctx.callerSessionId)
      return { resultType: "complete" }
  }
}
