/**
 * Semantic conversation record + reducer — PORTED near-verbatim from
 * packages/vscode/src/webview/conversation.ts (which is itself pure and
 * dependency-free). The only changes for this package: the record boundary's
 * `unknown` values are typed `JsonValue` (this package forbids `unknown`), and
 * the import points at the ported data/types. The grouping/fold/tool-card
 * invariants are unchanged:
 *   (1) fold only reasoning+tool; conclusions stay top-level (MIN_ACTIVITY_GROUP)
 *   (2) call+result = one card keyed by toolCallId; status pending/ok/error;
 *       TOOL_IO_MAX_LINES=3 clamp.
 *
 * reduceConversation is a FULL REPLAY over the accumulated records — pure,
 * idempotent, stable ids from `seq`, defensive dedup of duplicate/unordered seqs.
 */

import type { JsonValue, SessionEventRecord } from "../data/types"

/** Bump when the semantic record shape changes incompatibly. */
export const CONVERSATION_SCHEMA_VERSION = 1

export type SegmentKind =
  | "user"
  | "assistant-text"
  | "reasoning"
  | "tool"
  | "plan"
  | "agent-question"
  | "error"

interface SegmentBase {
  id: string
  seq: number
  ts?: string
}

export interface TextSegment extends SegmentBase {
  kind: "user" | "assistant-text" | "reasoning"
  text: string
}

export interface ToolSegment extends SegmentBase {
  kind: "tool"
  toolCallId?: string
  toolName?: string
  arguments?: JsonValue
  result?: JsonValue
  isError: boolean
  status: "pending" | "ok" | "error"
}

export interface PlanEntry {
  content: string
  priority: string
  status: string
}

export interface PlanSegment extends SegmentBase {
  kind: "plan"
  entries: PlanEntry[]
  done: number
  total: number
}

export interface QuestionSegment extends SegmentBase {
  kind: "agent-question"
  options: string[]
}

export interface ErrorSegment extends SegmentBase {
  kind: "error"
  message: string
}

export type ConversationSegment =
  | TextSegment
  | ToolSegment
  | PlanSegment
  | QuestionSegment
  | ErrorSegment

export interface ConversationTurn {
  id: string
  role: "user" | "assistant"
  startedAt?: string
  segments: ConversationSegment[]
}

export interface ConversationUsage {
  size?: number
  used?: number
  cost?: { amount: number; currency: string }
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
  contextSize?: number
  contextUsed?: number
  source?: string
  seq: number
  ts?: string
}

export interface Conversation {
  version: number
  sessionId: string
  turns: ConversationTurn[]
  usage?: ConversationUsage
  cursor: number
}

/**
 * Fold a full (accumulated) record list into a semantic conversation.
 * Idempotent over duplicate/unordered seqs.
 */
export function reduceConversation(
  sessionId: string,
  records: readonly SessionEventRecord[],
): Conversation {
  // Defensive normalization: ascending seq, first-wins on duplicates.
  const seen = new Set<number>()
  const ordered = [...records]
    .filter((r) => typeof r.seq === "number")
    .sort((a, b) => a.seq - b.seq)
    .filter((r) => (seen.has(r.seq) ? false : (seen.add(r.seq), true)))

  const turns: ConversationTurn[] = []
  let assistant: ConversationTurn | undefined
  let usage: ConversationUsage | undefined
  const toolIndex = new Map<string, ToolSegment>()
  let cursor = 0

  const openAssistant = (rec: SessionEventRecord): ConversationTurn => {
    if (!assistant) {
      assistant = { id: `turn-${rec.seq}`, role: "assistant", startedAt: rec.ts, segments: [] }
      turns.push(assistant)
    }
    return assistant
  }

  for (const rec of ordered) {
    cursor = rec.seq
    switch (rec.kind) {
      case "user-prompt": {
        assistant = undefined
        turns.push({
          id: `turn-${rec.seq}`,
          role: "user",
          startedAt: rec.ts,
          segments: [
            { kind: "user", id: `seg-${rec.seq}`, seq: rec.seq, ts: rec.ts, text: rec.text ?? "" },
          ],
        })
        break
      }
      case "text-delta": {
        if (!rec.text) break
        const turn = openAssistant(rec)
        const last = turn.segments[turn.segments.length - 1]
        if (last && last.kind === "assistant-text") {
          last.text += rec.text
        } else {
          turn.segments.push({
            kind: "assistant-text",
            id: `seg-${rec.seq}`,
            seq: rec.seq,
            ts: rec.ts,
            text: rec.text,
          })
        }
        break
      }
      case "thought": {
        if (!rec.text) break
        const turn = openAssistant(rec)
        const last = turn.segments[turn.segments.length - 1]
        if (last && last.kind === "reasoning") {
          last.text += rec.text
        } else {
          turn.segments.push({
            kind: "reasoning",
            id: `seg-${rec.seq}`,
            seq: rec.seq,
            ts: rec.ts,
            text: rec.text,
          })
        }
        break
      }
      case "tool-call": {
        // A repeat tool-call for a KNOWN id enriches the announced call; it
        // never opens a second one. Only ever ADD information.
        const known = rec.toolCallId ? toolIndex.get(rec.toolCallId) : undefined
        if (known) {
          if (rec.toolName) known.toolName = rec.toolName
          if (rec.arguments !== undefined) known.arguments = rec.arguments
          break
        }
        const turn = openAssistant(rec)
        const seg: ToolSegment = {
          kind: "tool",
          id: rec.toolCallId ? `tool-${rec.toolCallId}` : `seg-${rec.seq}`,
          seq: rec.seq,
          ts: rec.ts,
          toolCallId: rec.toolCallId,
          toolName: rec.toolName,
          arguments: rec.arguments,
          isError: false,
          status: "pending",
        }
        turn.segments.push(seg)
        if (rec.toolCallId) toolIndex.set(rec.toolCallId, seg)
        break
      }
      case "tool-result": {
        const existing = rec.toolCallId ? toolIndex.get(rec.toolCallId) : undefined
        if (existing) {
          existing.result = rec.result
          existing.isError = rec.isError ?? false
          existing.status = existing.isError ? "error" : "ok"
        } else {
          const turn = openAssistant(rec)
          turn.segments.push({
            kind: "tool",
            id: rec.toolCallId ? `tool-${rec.toolCallId}` : `seg-${rec.seq}`,
            seq: rec.seq,
            ts: rec.ts,
            toolCallId: rec.toolCallId,
            result: rec.result,
            isError: rec.isError ?? false,
            status: rec.isError ? "error" : "ok",
          })
        }
        break
      }
      case "plan": {
        const turn = openAssistant(rec)
        const entries = rec.entries ?? []
        const done = entries.filter((e) => e.status === "completed").length
        const prevPlan = turn.segments.find((s): s is PlanSegment => s.kind === "plan")
        if (prevPlan) {
          prevPlan.entries = entries
          prevPlan.done = done
          prevPlan.total = entries.length
          prevPlan.ts = rec.ts
        } else {
          turn.segments.push({
            kind: "plan",
            id: `seg-${rec.seq}`,
            seq: rec.seq,
            ts: rec.ts,
            entries,
            done,
            total: entries.length,
          })
        }
        break
      }
      case "agent-prompt": {
        const turn = openAssistant(rec)
        turn.segments.push({
          kind: "agent-question",
          id: `seg-${rec.seq}`,
          seq: rec.seq,
          ts: rec.ts,
          options: normalizeOptions(rec.options),
        })
        break
      }
      case "error": {
        const turn = openAssistant(rec)
        turn.segments.push({
          kind: "error",
          id: `seg-${rec.seq}`,
          seq: rec.seq,
          ts: rec.ts,
          message: rec.error?.message ?? "unknown error",
        })
        break
      }
      case "usage_update":
      case "usage_snapshot": {
        usage = mergeUsage(usage, rec)
        break
      }
      case "turn-end":
        assistant = undefined
        break
      default:
        break
    }
  }

  return { version: CONVERSATION_SCHEMA_VERSION, sessionId, turns, usage, cursor }
}

function mergeUsage(
  prev: ConversationUsage | undefined,
  rec: SessionEventRecord,
): ConversationUsage {
  const next: ConversationUsage = { ...(prev ?? {}), seq: rec.seq, ts: rec.ts }
  if (rec.size !== undefined) next.size = rec.size
  if (rec.used !== undefined) next.used = rec.used
  if (rec.cost !== undefined) next.cost = rec.cost
  if (rec.costUsd !== undefined) next.costUsd = rec.costUsd
  if (rec.tokensIn !== undefined) next.tokensIn = rec.tokensIn
  if (rec.tokensOut !== undefined) next.tokensOut = rec.tokensOut
  if (rec.contextSize !== undefined) next.contextSize = rec.contextSize
  if (rec.contextUsed !== undefined) next.contextUsed = rec.contextUsed
  if (typeof rec.source === "string") next.source = rec.source
  return next
}

/**
 * Narrow an agent-prompt event's `options` into a flat label list — accepts
 * plain strings or objects exposing label/name/id/optionId.
 */
function normalizeOptions(raw: JsonValue | undefined): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const o of raw) {
    if (typeof o === "string") {
      out.push(o)
      continue
    }
    if (o !== null && typeof o === "object" && !Array.isArray(o)) {
      const label = o.label ?? o.name ?? o.id ?? o.optionId
      if (typeof label === "string") out.push(label)
    }
  }
  return out
}

// ── Presentation layer (injected renderers) ─────────────────────────────────

export interface PresentedTextSegment {
  kind: "user" | "assistant-text" | "reasoning"
  id: string
  html: string
}

export interface PresentedToolSegment {
  kind: "tool"
  id: string
  toolName?: string
  argsText?: string
  argsClamped?: boolean
  argsLines?: number
  resultText?: string
  resultClamped?: boolean
  resultLines?: number
  isError: boolean
  status: "pending" | "ok" | "error"
  ts?: string
}

export interface PresentedPlanSegment {
  kind: "plan"
  id: string
  entries: PlanEntry[]
  done: number
  total: number
}

export interface PresentedQuestionSegment {
  kind: "agent-question"
  id: string
  options: string[]
}

export interface PresentedErrorSegment {
  kind: "error"
  id: string
  text: string
}

export type PresentedActivityChild = PresentedTextSegment | PresentedToolSegment

export interface PresentedActivitySegment {
  kind: "activity"
  id: string
  children: PresentedActivityChild[]
  summary: string
  count: number
  status: "pending" | "ok" | "error"
  pendingSince?: string
}

export type PresentedSegment =
  | PresentedTextSegment
  | PresentedToolSegment
  | PresentedPlanSegment
  | PresentedQuestionSegment
  | PresentedErrorSegment
  | PresentedActivitySegment

export interface PresentedTurn {
  id: string
  role: "user" | "assistant"
  segments: PresentedSegment[]
}

export interface PresentedConversation {
  version: number
  sessionId: string
  turns: PresentedTurn[]
  usage?: ConversationUsage
}

export interface Renderers {
  /** Markdown → safe (escaped) HTML. */
  renderMarkdown: (text: string) => string
  /** Plain-text → escaped HTML. */
  escapeHtml: (text: string) => string
}

/** Build the render-facing view model from a semantic conversation. */
export function presentConversation(
  conversation: Conversation,
  renderers: Renderers,
): PresentedConversation {
  return {
    version: conversation.version,
    sessionId: conversation.sessionId,
    usage: conversation.usage,
    turns: conversation.turns.map((turn) => ({
      id: turn.id,
      role: turn.role,
      segments: groupActivity(turn.segments.map((seg) => presentSegment(seg, renderers))),
    })),
  }
}

/** A lone step is left ungrouped — folding it would add nesting and buy nothing. */
const MIN_ACTIVITY_GROUP = 2

function isActivityChild(seg: PresentedSegment): seg is PresentedActivityChild {
  return seg.kind === "reasoning" || seg.kind === "tool"
}

/**
 * Fold each run of consecutive reasoning/tool segments into one activity group.
 * Order preserved, nothing dropped — purely presentational and reversible.
 */
export function groupActivity(segments: readonly PresentedSegment[]): PresentedSegment[] {
  const out: PresentedSegment[] = []
  let run: PresentedActivityChild[] = []

  const flush = (): void => {
    if (run.length === 0) return
    if (run.length < MIN_ACTIVITY_GROUP) out.push(...run)
    else out.push(buildActivity(run))
    run = []
  }

  for (const seg of segments) {
    if (isActivityChild(seg)) {
      run.push(seg)
      continue
    }
    flush()
    out.push(seg)
  }
  flush()
  return out
}

function buildActivity(children: PresentedActivityChild[]): PresentedActivitySegment {
  const pending = children.find(
    (c): c is PresentedToolSegment => c.kind === "tool" && c.status === "pending",
  )
  const failed = children.filter((c) => c.kind === "tool" && c.status === "error").length
  // The badge answers "how did this run END", not "did anything ever fail" — a
  // recovered failure mid-run is normal agent work, not a failed run.
  const last = children[children.length - 1]
  const endedOnFailure = last !== undefined && last.kind === "tool" && last.status === "error"
  const status: PresentedActivitySegment["status"] = pending
    ? "pending"
    : endedOnFailure
      ? "error"
      : "ok"
  const first = children[0]
  if (!first) throw new Error("buildActivity called with no children")
  return {
    kind: "activity",
    id: `act-${first.id}`,
    children,
    summary: activitySummary(children, pending, failed),
    count: children.length,
    status,
    ...(pending?.ts !== undefined ? { pendingSince: pending.ts } : {}),
  }
}

function activitySummary(
  children: readonly PresentedActivityChild[],
  pending: PresentedActivityChild | undefined,
  failed: number,
): string {
  const steps = `${children.length} step${children.length === 1 ? "" : "s"}`
  if (pending) return `${stepLabel(pending)} · ${steps}`
  return failed > 0 ? `${steps} · ${failed} failed` : steps
}

function stepLabel(seg: PresentedActivityChild): string {
  if (seg.kind === "reasoning") return "Thinking"
  return seg.kind === "tool" ? (seg.toolName ?? "tool") : "Working"
}

function presentSegment(seg: ConversationSegment, r: Renderers): PresentedSegment {
  switch (seg.kind) {
    case "user":
    case "assistant-text":
    case "reasoning":
      return { kind: seg.kind, id: seg.id, html: r.renderMarkdown(seg.text) }
    case "tool": {
      const args =
        seg.arguments === undefined
          ? undefined
          : clampToLines(stringifyToolValue(seg.arguments))
      const result =
        seg.result === undefined ? undefined : clampToLines(stringifyToolValue(seg.result))
      return {
        kind: "tool",
        id: seg.id,
        toolName: seg.toolName,
        ...(args
          ? {
              argsText: r.escapeHtml(args.preview),
              argsClamped: args.clamped,
              argsLines: args.lineCount,
            }
          : {}),
        ...(result
          ? {
              resultText: r.escapeHtml(result.preview),
              resultClamped: result.clamped,
              resultLines: result.lineCount,
            }
          : {}),
        isError: seg.isError,
        status: seg.status,
        ts: seg.ts,
      }
    }
    case "plan":
      return { kind: "plan", id: seg.id, entries: seg.entries, done: seg.done, total: seg.total }
    case "agent-question":
      return { kind: "agent-question", id: seg.id, options: seg.options }
    case "error":
      return { kind: "error", id: seg.id, text: r.escapeHtml(seg.message) }
  }
}

/** Compact, human-readable rendering of an arbitrary tool arg/result value. */
export function stringifyToolValue(value: JsonValue): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** True when the value renders as JSON rather than plain text. */
export function isJsonToolValue(value: JsonValue): boolean {
  return typeof value !== "string"
}

/**
 * How many lines of a tool's input/output the transcript shows inline. A tool
 * card is a step in a story, not a log viewer; three lines is enough to
 * recognize the call.
 */
export const TOOL_IO_MAX_LINES = 3

export interface ClampedText {
  preview: string
  clamped: boolean
  lineCount: number
}

/** Take the first `maxLines` lines (line-based clamp; horizontal overflow is CSS). */
export function clampToLines(text: string, maxLines: number = TOOL_IO_MAX_LINES): ClampedText {
  const lines = text.split("\n")
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  const lineCount = lines.length
  if (lineCount <= maxLines) return { preview: lines.join("\n"), clamped: false, lineCount }
  return { preview: lines.slice(0, maxLines).join("\n"), clamped: true, lineCount }
}
