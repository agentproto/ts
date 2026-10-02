/**
 * `session_evidence` — the compact, read-only evidence object the
 * session-steward workflow (FIX-9B) hands its judge agent for ONE idle
 * session: identity, liveness flags, the last few user/assistant turns
 * (trimmed), and — for a session in a linked worktree — the branch, dirty
 * counts, ahead/behind and PR state. Everything here is cheap and
 * in-process: a bounded tail read of the session's `events.jsonl` plus one
 * worktree status lookup. Nothing here mutates anything.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import type { SessionDescriptor } from "./sessions.js"
import type { WorktreeStatusView } from "./worktree-status.js"

/** How much of the transcript's tail is read — enough for ~10 turns of a
 *  chatty session without ever reading a multi-MB transcript whole. */
export const EVIDENCE_TAIL_BYTES = 256 * 1024
/** Most turns kept (user + assistant each count as one). */
export const EVIDENCE_MAX_TURNS = 10
/** Character budget across every kept turn's text. */
export const EVIDENCE_TURNS_MAX_CHARS = 3_000
/** Longest single turn kept before trimming, so one huge report can't eat
 *  the whole budget. */
export const EVIDENCE_TURN_MAX_CHARS = 900

export interface EvidenceTurn {
  role: "user" | "assistant"
  text: string
}

/** Compact stats over one session's recent `tool_calls_list` records — the
 *  `toolStats` evidence the judge reads (SESSIONS-LOG "Critère à ajouter à
 *  Jev"): distinct vs repeated calls, the top repeated command, and distinct
 *  vs repeated file reads. Pure over the records; the same numbers the
 *  steward's mechanical loop rule computes. */
export interface ToolCallStats {
  total: number
  distinct: number
  repeated: number
  /** `distinct / total`, rounded to 2 dp; 1 when there were no calls. */
  ratio: number
  topCommand: string | null
  topCommandCount: number
  distinctReads: number
  repeatedReads: number
}

/** The last tool call, normalized for evidence (name + shell command when
 *  the call was shell-shaped + an explicit `kind` when a caller supplied one). */
export interface EvidenceLastToolCall {
  tool: string
  command?: string
  kind?: string
  ts?: string
  isError?: boolean
}

export interface SessionEvidence {
  sessionId: string
  label?: string
  cwd?: string
  adapter?: string
  status: string
  keepAlive: boolean
  awaitingInput: boolean
  busy: boolean
  idleMinutes?: number
  turnsCompleted?: number
  turns: EvidenceTurn[]
  /** Provenance, copied from the descriptor so the judge can tell a human's
   *  session from a cron/executor one without a second lookup. */
  origin?: string
  parentSessionId?: string
  /** Number of live (running/starting) direct children at read time. */
  liveChildren?: number
  /** Session lineage (`continuedFrom` / `continuedTo` on the descriptor). */
  continuedFrom?: string
  continuedTo?: string
  tokensIn?: number
  tokensOut?: number
  lastTurnErroredAt?: string
  /** The adapter-reported error text for the last errored turn. */
  lastTurnError?: string
  /** The derived outcome, compacted: status + a judge/rule verdict + summary. */
  outcome?: { status: string; verdict?: string; summary?: string }
  /** Opened/merged PR counts for the session — from the descriptor's
   *  `openedPrs` and the worktree PR state. */
  pullRequests?: { opened: number; merged: number; state: string | null }
  /** Repetition stats over the recent tool-call window. */
  toolStats?: ToolCallStats
  lastToolCall?: EvidenceLastToolCall
  /** Minutes since the last user / assistant message in the transcript tail. */
  minutesSinceUserMessage?: number
  minutesSinceAgentMessage?: number
  /** The verdict the steward recorded for this session on a previous pass
   *  (from `app_state`), so the judge can see a stable history. */
  previousVerdict?: { verdict: string; confidence?: number | null; streak?: number; ts?: string | null }
  worktree?: {
    branch: string | null
    dirty: boolean
    changes?: { modified: number; staged: number; untracked: number }
    ahead?: number
    behind?: number
    pr: null | { state: string; number?: number }
  }
}

/** `text` cut to `max` chars: the head for a user turn (the ask is at the
 *  start), the tail for an assistant turn (the conclusion is at the end). */
function trimTurn(text: string, max: number, keep: "head" | "tail"): string {
  const t = text.trim()
  if (t.length <= max) return t
  return keep === "head" ? `${t.slice(0, max - 1)}…` : `…${t.slice(t.length - (max - 1))}`
}

/**
 * The last `maxTurns` user/assistant turns of an `events.jsonl` transcript,
 * oldest first, read from at most the final `tailBytes` bytes. A user turn
 * is a `user-prompt` record; an assistant turn is the run of `text-delta`
 * records until the next prompt or `turn-end` (tool calls in between don't
 * split it — their text is not included). Then trimmed newest-first to the
 * total `maxChars` budget, so the most recent exchange always survives.
 * Returns `[]` on any read error.
 */
export function readRecentTurnsSync(
  eventsPath: string,
  opts: { maxTurns?: number; maxChars?: number; tailBytes?: number } = {},
): EvidenceTurn[] {
  const maxTurns = opts.maxTurns ?? EVIDENCE_MAX_TURNS
  const maxChars = opts.maxChars ?? EVIDENCE_TURNS_MAX_CHARS
  const tailBytes = opts.tailBytes ?? EVIDENCE_TAIL_BYTES
  let fd: number
  try {
    fd = openSync(eventsPath, "r")
  } catch {
    return []
  }
  let tail: string
  try {
    const size = fstatSync(fd).size
    const len = Math.min(size, tailBytes)
    if (len === 0) return []
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    tail = buf.toString("utf8")
  } catch {
    return []
  } finally {
    closeSync(fd)
  }

  const turns: EvidenceTurn[] = []
  let assistant: string | undefined
  const closeAssistant = (): void => {
    if (assistant !== undefined && assistant.trim()) turns.push({ role: "assistant", text: assistant })
    assistant = undefined
  }
  for (const line of tail.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rec: { kind?: unknown; text?: unknown }
    try {
      rec = JSON.parse(trimmed) as { kind?: unknown; text?: unknown }
    } catch {
      continue // the window's first line is usually torn
    }
    if (rec.kind === "user-prompt" && typeof rec.text === "string") {
      closeAssistant()
      if (rec.text.trim()) turns.push({ role: "user", text: rec.text })
    } else if (rec.kind === "text-delta" && typeof rec.text === "string") {
      assistant = (assistant ?? "") + rec.text
    } else if (rec.kind === "turn-end") {
      closeAssistant()
    }
  }
  closeAssistant()

  const kept: EvidenceTurn[] = []
  let budget = maxChars
  for (let i = turns.length - 1; i >= 0 && kept.length < maxTurns && budget > 0; i--) {
    const t = turns[i]!
    const text = trimTurn(t.text, Math.min(EVIDENCE_TURN_MAX_CHARS, budget), t.role === "user" ? "head" : "tail")
    budget -= text.length
    kept.unshift({ role: t.role, text })
  }
  return kept
}

/** The tail of a transcript's `tool-call-record` lines (the same records
 *  `tool_calls_list` reads), newest last, bounded to `tailBytes` and `max`
 *  records — a cheap read for the `toolStats` evidence. Absence is not an
 *  error. */
export function readRecentToolCallRecordsSync(
  eventsPath: string,
  opts: { tailBytes?: number; max?: number } = {},
): Array<{ tool?: string; command?: string; args?: string[]; ts?: string; isError?: boolean }> {
  const tailBytes = opts.tailBytes ?? EVIDENCE_TAIL_BYTES
  const max = opts.max ?? 120
  let fd: number
  try {
    fd = openSync(eventsPath, "r")
  } catch {
    return []
  }
  let tail: string
  try {
    const size = fstatSync(fd).size
    const len = Math.min(size, tailBytes)
    if (len === 0) return []
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    tail = buf.toString("utf8")
  } catch {
    return []
  } finally {
    closeSync(fd)
  }
  const out: Array<{ tool?: string; command?: string; args?: string[]; ts?: string; isError?: boolean }> = []
  for (const line of tail.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }
    if (rec.kind !== "tool-call-record") continue
    out.push({
      ...(typeof rec.tool === "string" ? { tool: rec.tool } : {}),
      ...(typeof rec.command === "string" ? { command: rec.command } : {}),
      ...(Array.isArray(rec.args) && rec.args.every(a => typeof a === "string") ? { args: rec.args as string[] } : {}),
      ...(typeof rec.ts === "string" ? { ts: rec.ts } : {}),
      ...(rec.isError === true ? { isError: true } : {}),
    })
  }
  return out.slice(-max)
}

/** The verbatim signature of one tool-call record (tool + command + args),
 *  the same "même commande relancée verbatim" signal the steward's loop rule
 *  uses. Kept local so the runtime does not import the app bundle. */
export function toolCallSignature(record: { tool?: unknown; command?: unknown; args?: unknown }): string {
  const tool = typeof record?.tool === "string" && record.tool.trim() ? record.tool.trim() : "unknown"
  const command = typeof record?.command === "string" ? record.command.trim() : ""
  const args = Array.isArray(record?.args) ? record.args.map(String).join(" ") : ""
  return `${tool} ${command} ${args}`.replace(/\s+/g, " ").trim()
}

const EVIDENCE_READ_TOOLS = new Set(["read", "cat", "rg", "grep", "sed", "head", "tail", "less", "view", "readfile"])
const EVIDENCE_READ_COMMAND = /\b(cat|rg|grep|sed|head|tail|less|view)\b/

/** Best-effort read target of one record, mirroring the steward's loop rule. */
function evidenceReadTarget(record: { tool?: unknown; command?: unknown; args?: unknown }): string | null {
  const tool = String(record?.tool ?? "").toLowerCase()
  const command = typeof record?.command === "string" ? record.command : undefined
  const args = Array.isArray(record?.args) ? record.args.map(String) : []
  const isRead = EVIDENCE_READ_TOOLS.has(tool) || (command !== undefined && EVIDENCE_READ_COMMAND.test(command))
  if (!isRead) return null
  const tokens = command !== undefined ? command.split(/\s+/) : args
  for (const raw of tokens) {
    const t = raw.replace(/^['"]|['"]$/g, "")
    if (!t || t.startsWith("-") || t.includes("=")) continue
    if (t.includes("/") || /\.(md|ts|tsx|js|mjs|cjs|json|txt|py|go|rs|sql|yml|yaml|toml)$/.test(t)) return t
  }
  return args[0] ?? null
}

/** Summarize a session's tool calls into the `toolStats` evidence. */
export function summarizeToolCalls(records: readonly { tool?: unknown; command?: unknown; args?: unknown }[]): ToolCallStats {
  const counts = new Map<string, number>()
  const reads = new Map<string, number>()
  for (const r of records ?? []) {
    const sig = toolCallSignature(r)
    counts.set(sig, (counts.get(sig) ?? 0) + 1)
    const target = evidenceReadTarget(r)
    if (target) reads.set(target, (reads.get(target) ?? 0) + 1)
  }
  const total = records?.length ?? 0
  const distinct = counts.size
  let topCommand: string | null = null
  let topCommandCount = 0
  for (const [key, n] of counts) if (n > topCommandCount) ((topCommand = key), (topCommandCount = n))
  const repeatedReads = [...reads.values()].reduce((m, n) => Math.max(m, n), 0)
  return {
    total,
    distinct,
    repeated: total - distinct,
    ratio: total > 0 ? Math.round((distinct / total) * 100) / 100 : 1,
    topCommand,
    topCommandCount,
    distinctReads: reads.size,
    repeatedReads,
  }
}

/**
 * The timestamps of the last user and last assistant message in a
 * transcript tail (from the records' `ts`). Returns `{}` when the file is
 * missing/unreadable or carries no timestamps — never an error.
 */
export function readLastMessageTimesSync(
  eventsPath: string,
  opts: { tailBytes?: number } = {},
): { lastUserAt?: string; lastAgentAt?: string } {
  const tailBytes = opts.tailBytes ?? EVIDENCE_TAIL_BYTES
  let fd: number
  try {
    fd = openSync(eventsPath, "r")
  } catch {
    return {}
  }
  let tail: string
  try {
    const size = fstatSync(fd).size
    const len = Math.min(size, tailBytes)
    if (len === 0) return {}
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    tail = buf.toString("utf8")
  } catch {
    return {}
  } finally {
    closeSync(fd)
  }
  const out: { lastUserAt?: string; lastAgentAt?: string } = {}
  for (const line of tail.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rec: { kind?: unknown; ts?: unknown }
    try {
      rec = JSON.parse(trimmed) as { kind?: unknown; ts?: unknown }
    } catch {
      continue
    }
    if (typeof rec.ts !== "string") continue
    if (rec.kind === "user-prompt") out.lastUserAt = rec.ts
    else if (rec.kind === "text-delta") out.lastAgentAt = rec.ts
  }
  return out
}

/** Project a descriptor + its turns + its worktree view into the compact
 *  evidence object. `nowMs` drives `idleMinutes`. Every enriched field is
 *  OPTIONAL — an old caller that passes only `{desc, turns, nowMs}` gets the
 *  same object shape it did before, minus the new keys. */
export function buildSessionEvidence(input: {
  desc: SessionDescriptor
  turns: EvidenceTurn[]
  worktree?: WorktreeStatusView
  nowMs: number
  toolStats?: ToolCallStats
  lastToolCall?: EvidenceLastToolCall
  liveChildren?: number
  lastUserAt?: string
  lastAgentAt?: string
  pullRequests?: { opened: number; merged: number; state: string | null }
  previousVerdict?: { verdict: string; confidence?: number | null; streak?: number; ts?: string | null }
}): SessionEvidence {
  const { desc, turns, worktree, nowMs } = input
  const lastTs = desc.lastActivityAt ?? desc.startedAt
  const lastMs = lastTs ? Date.parse(lastTs) : Number.NaN
  const minutesSince = (ts?: string): number | undefined => {
    if (!ts) return undefined
    const ms = Date.parse(ts)
    return Number.isFinite(ms) ? Math.max(0, Math.floor((nowMs - ms) / 60_000)) : undefined
  }
  const minutesSinceUser = minutesSince(input.lastUserAt)
  const minutesSinceAgent = minutesSince(input.lastAgentAt)
  return {
    sessionId: desc.id,
    ...(desc.label ?? desc.name ? { label: desc.label ?? desc.name } : {}),
    ...(desc.cwd ? { cwd: desc.cwd } : {}),
    ...(desc.adapterSlug ? { adapter: desc.adapterSlug } : {}),
    status: desc.status,
    keepAlive: desc.keepAlive === true,
    awaitingInput: desc.awaitingInput === true,
    busy: desc.busy === true,
    ...(Number.isFinite(lastMs) ? { idleMinutes: Math.max(0, Math.floor((nowMs - lastMs) / 60_000)) } : {}),
    ...(desc.turnsCompleted !== undefined ? { turnsCompleted: desc.turnsCompleted } : {}),
    turns,
    ...(desc.origin ? { origin: desc.origin } : {}),
    ...(desc.parentSessionId ? { parentSessionId: desc.parentSessionId } : {}),
    ...(input.liveChildren !== undefined ? { liveChildren: input.liveChildren } : {}),
    ...(desc.continuedFrom ? { continuedFrom: desc.continuedFrom } : {}),
    ...(desc.continuedTo ? { continuedTo: desc.continuedTo } : {}),
    ...(desc.tokensIn !== undefined ? { tokensIn: desc.tokensIn } : {}),
    ...(desc.tokensOut !== undefined ? { tokensOut: desc.tokensOut } : {}),
    ...(desc.lastTurnErroredAt ? { lastTurnErroredAt: desc.lastTurnErroredAt } : {}),
    ...(desc.lastTurnErrorMessage ? { lastTurnError: desc.lastTurnErrorMessage } : {}),
    ...(desc.outcome
      ? {
          outcome: {
            status: desc.outcome.status,
            ...(desc.outcome.verdict ? { verdict: desc.outcome.verdict } : {}),
            ...(desc.outcome.summary ? { summary: desc.outcome.summary } : {}),
          },
        }
      : {}),
    ...(input.pullRequests ? { pullRequests: input.pullRequests } : {}),
    ...(input.toolStats ? { toolStats: input.toolStats } : {}),
    ...(input.lastToolCall ? { lastToolCall: input.lastToolCall } : {}),
    ...(minutesSinceUser !== undefined ? { minutesSinceUserMessage: minutesSinceUser } : {}),
    ...(minutesSinceAgent !== undefined ? { minutesSinceAgentMessage: minutesSinceAgent } : {}),
    ...(input.previousVerdict ? { previousVerdict: input.previousVerdict } : {}),
    ...(worktree
      ? {
          worktree: {
            branch: worktree.branch,
            dirty: worktree.dirty,
            ...(worktree.changes ? { changes: worktree.changes } : {}),
            ...(worktree.base ? { ahead: worktree.base.ahead, behind: worktree.base.behind } : {}),
            pr: worktree.pr ? { state: worktree.pr.state, ...(worktree.pr.number !== undefined ? { number: worktree.pr.number } : {}) } : null,
          },
        }
      : {}),
  }
}
