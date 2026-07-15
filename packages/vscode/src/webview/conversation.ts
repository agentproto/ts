/**
 * Versioned semantic conversation record + reducer — the boundary that turns
 * the daemon's flat, already-normalized `SessionEventRecord` stream
 * (GET /sessions/:id/events) into a structured chat timeline suitable for
 * persistence and UI replay.
 *
 * Contract:
 *   - Pure and dependency-free (no vscode, no host modules) so it runs in the
 *     extension host, in tests, and — in principle — server-side for
 *     persistence. Markdown/HTML rendering is a SEPARATE presentation step
 *     (`presentConversation`, injected renderers) so the semantic record
 *     stays render-agnostic and secret-free.
 *   - Provider/model normalization already happened at the adapter/protocol
 *     boundary; this reducer only GROUPS normalized events into turns and
 *     segments. It never inspects a raw provider payload.
 *   - Stable identity: turn/segment ids derive from the durable, now-monotonic
 *     `seq` (see transcript-writer.ts), so re-reducing after each incremental
 *     poll yields identical ids — the webview keeps per-segment expand/collapse
 *     state and scroll across live updates, and duplicate records (overlapping
 *     poll windows) can never produce duplicate segments.
 *   - `reduceConversation` is a FULL REPLAY over the accumulated record list.
 *     Deterministic and idempotent: reducing a superset that starts with the
 *     same prefix appends only the new tail. Duplicate/out-of-order `seq`s are
 *     sorted and de-duplicated defensively.
 */

import type { SessionEventRecord } from "../client/types.js"

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
  /** Stable id derived from the originating record's seq (or tool-call id). */
  id: string
  /** seq of the first record that opened this segment. */
  seq: number
  /** ISO timestamp of the first contributing record, when known. */
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
  arguments?: unknown
  result?: unknown
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
  /** Stable id from the seq of the record that opened the turn. */
  id: string
  role: "user" | "assistant"
  startedAt?: string
  segments: ConversationSegment[]
}

/** Latest usage recap — conversation-level metadata, not an inline segment. */
export interface ConversationUsage {
  size?: number
  used?: number
  cost?: { amount: number; currency: string }
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
  contextSize?: number
  contextUsed?: number
  /** Where the numbers came from (adapter/computed/…), when the runtime says. */
  source?: string
  /** seq of the record this recap came from. */
  seq: number
  ts?: string
}

export interface Conversation {
  version: number
  sessionId: string
  turns: ConversationTurn[]
  usage?: ConversationUsage
  /** Highest seq folded into this conversation (0 when empty). */
  cursor: number
}

/**
 * Fold a full (accumulated) record list into a semantic conversation.
 * Idempotent over duplicate/unordered seqs. See module header for the replay
 * contract.
 */
export function reduceConversation(
  sessionId: string,
  records: readonly SessionEventRecord[],
): Conversation {
  // Defensive normalization: ascending seq, first-wins on duplicates.
  const seen = new Set<number>()
  const ordered = [...records]
    .filter(r => typeof r.seq === "number")
    .sort((a, b) => a.seq - b.seq)
    .filter(r => (seen.has(r.seq) ? false : (seen.add(r.seq), true)))

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
        // A new prompt closes any open assistant turn so the next assistant
        // activity starts a fresh bubble.
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
          // Result with no captured call (e.g. hydration window started
          // mid-tool) — still surface it as its own card.
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
        const done = entries.filter(e => e.status === "completed").length
        // A plan streams updates — collapse them onto one segment per turn
        // (keeping the first segment's stable id) instead of stacking dupes.
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
        // Merge defined fields so an update (size/used/cost) and a snapshot
        // (costUsd/tokens/context) accumulate rather than clobber each other.
        usage = mergeUsage(usage, rec)
        break
      }
      case "turn-end":
        assistant = undefined
        break
      default:
        // Unknown kind — ignore, same as the daemon exporter.
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
 * Narrow an agent-prompt event's `options` (typed `unknown` at the record
 * boundary) into a flat label list — accepts plain strings or objects
 * exposing `label`/`name`/`id`/`optionId`. Mirrors the daemon's own
 * `normalizeAgentPromptOptions` (sessions.ts) so the two agree.
 */
function normalizeOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const o of raw) {
    if (typeof o === "string") {
      out.push(o)
      continue
    }
    if (o && typeof o === "object") {
      const r = o as Record<string, unknown>
      const label = r.label ?? r.name ?? r.id ?? r.optionId
      if (typeof label === "string") out.push(label)
    }
  }
  return out
}

// ── Presentation layer (host-side, injected renderers) ──────────────────
//
// The webview must never parse raw content, and all daemon text must be
// escaped before it reaches innerHTML. So the extension host renders each
// text-bearing segment to safe HTML here (via the injected markdown renderer)
// and ships a `PresentedConversation` the webview renders structurally. This
// keeps the semantic `Conversation` render-agnostic (persistence) and the
// webview credential-/parse-free (UI replay).

export interface PresentedTextSegment {
  kind: "user" | "assistant-text" | "reasoning"
  id: string
  html: string
}

export interface PresentedToolSegment {
  kind: "tool"
  id: string
  toolName?: string
  /** Pretty-printed, escaped tool input (rendered in a <pre>). */
  argsText?: string
  /** Pretty-printed, escaped tool output (rendered in a <pre>). */
  resultText?: string
  isError: boolean
  status: "pending" | "ok" | "error"
  /** ISO timestamp the call opened — the webview's elapsed-time display for a pending call. */
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
  /** Escaped error message. */
  text: string
}

export type PresentedSegment =
  | PresentedTextSegment
  | PresentedToolSegment
  | PresentedPlanSegment
  | PresentedQuestionSegment
  | PresentedErrorSegment

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

/** Build the webview-facing view model from a semantic conversation. */
export function presentConversation(
  conversation: Conversation,
  renderers: Renderers,
): PresentedConversation {
  return {
    version: conversation.version,
    sessionId: conversation.sessionId,
    usage: conversation.usage,
    turns: conversation.turns.map(turn => ({
      id: turn.id,
      role: turn.role,
      segments: turn.segments.map(seg => presentSegment(seg, renderers)),
    })),
  }
}

function presentSegment(seg: ConversationSegment, r: Renderers): PresentedSegment {
  switch (seg.kind) {
    case "user":
    case "assistant-text":
    case "reasoning":
      return { kind: seg.kind, id: seg.id, html: r.renderMarkdown(seg.text) }
    case "tool":
      return {
        kind: "tool",
        id: seg.id,
        toolName: seg.toolName,
        argsText: seg.arguments === undefined ? undefined : r.escapeHtml(stringify(seg.arguments)),
        resultText: seg.result === undefined ? undefined : r.escapeHtml(stringify(seg.result)),
        isError: seg.isError,
        status: seg.status,
        ts: seg.ts,
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
function stringify(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
