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
  title?: string
  entries: PlanEntry[]
  done: number
  total: number
}

export interface QuestionSegment extends SegmentBase {
  kind: "agent-question"
  options: string[]
  /** Correlates this ask to its "permission-resolved" record (same
   *  toolCallId the daemon's "agent-prompt" carried) — absent for a
   *  question that isn't a respondable permission (e.g. an ACP driver
   *  that never sends a toolCallId). */
  toolCallId?: string
  /** optionId -> display label for THIS ask's offered options — same objects
   *  `options` was flattened from. Reducer-internal: lets a later
   *  "permission-resolved" record (which carries only an opaque optionId)
   *  resolve back to a human label without a second daemon round-trip. Not
   *  forwarded to the presented layer. */
  optionsById?: Record<string, string>
  /** Set once a "permission-resolved" record for this toolCallId arrives —
   *  an ask with this set is ANSWERED, not still awaiting a human. */
  resolved?: { decision: "approve" | "deny" | "cancelled"; optionId?: string; optionLabel?: string }
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
  /** User turns only: the prompt's provenance from the "user-prompt"
   *  record's `source` — `agent:<sessionId>` when another session injected
   *  it (a supervisor's agent_prompt / spawn prompt); absent for a human. */
  promptSource?: string
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
  const questionIndex = new Map<string, QuestionSegment>()
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
          ...(rec.source ? { promptSource: rec.source } : {}),
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
        // does not open a second one. ACP agents may announce a call before
        // they know its input — the claude-code bridge announces
        // `{title: "Read File", rawInput: {}}` and only afterwards sends the
        // real `{file_path: …}` plus a better title (see @agentproto/acp's
        // tool_call_update handling). Merging keeps one card per call, and
        // keeps the reduce idempotent under replay: the same records always
        // fold to the same segments.
        const known = rec.toolCallId ? toolIndex.get(rec.toolCallId) : undefined
        if (known) {
          // Only ever ADD information — an untitled or argument-less
          // enrichment must not erase what the announcement already told us.
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
        const title = rec.title || undefined
        // A plan streams updates — collapse them onto one segment per turn
        // (keeping the first segment's stable id) instead of stacking dupes.
        const prevPlan = turn.segments.find((s): s is PlanSegment => s.kind === "plan")
        if (prevPlan) {
          prevPlan.entries = entries
          prevPlan.done = done
          prevPlan.total = entries.length
          prevPlan.ts = rec.ts
          if (title) prevPlan.title = title
        } else {
          turn.segments.push({
            kind: "plan",
            id: `seg-${rec.seq}`,
            seq: rec.seq,
            ts: rec.ts,
            ...(title ? { title } : {}),
            entries,
            done,
            total: entries.length,
          })
        }
        break
      }
      case "agent-prompt": {
        const turn = openAssistant(rec)
        const optionsById = normalizeOptionsById(rec.options)
        const seg: QuestionSegment = {
          kind: "agent-question",
          id: `seg-${rec.seq}`,
          seq: rec.seq,
          ts: rec.ts,
          options: normalizeOptions(rec.options),
          ...(rec.toolCallId ? { toolCallId: rec.toolCallId } : {}),
          ...(optionsById ? { optionsById } : {}),
        }
        turn.segments.push(seg)
        if (rec.toolCallId) questionIndex.set(rec.toolCallId, seg)
        break
      }
      case "permission-resolved": {
        const seg = rec.toolCallId ? questionIndex.get(rec.toolCallId) : undefined
        if (seg && (rec.decision === "approve" || rec.decision === "deny" || rec.decision === "cancelled")) {
          const optionLabel = rec.optionId ? seg.optionsById?.[rec.optionId] : undefined
          seg.resolved = {
            decision: rec.decision,
            ...(rec.optionId ? { optionId: rec.optionId } : {}),
            ...(optionLabel ? { optionLabel } : {}),
          }
        }
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
        // A terminal event settles any legacy/orphaned tool starts that made
        // it into the transcript without a matching result. This is not a
        // timeout: the adapter has explicitly ended the turn.
        settlePendingTools(assistant)
        assistant = undefined
        break
      default:
        // Unknown kind — ignore, same as the daemon exporter.
        break
    }
  }

  return { version: CONVERSATION_SCHEMA_VERSION, sessionId, turns, usage, cursor }
}

/**
 * A terminal turn is conclusive even when an adapter omitted one or more
 * `tool-result` frames. Hermes can do this for nested/parallel calls, and
 * old durable transcripts cannot be repaired at the wire boundary. Settle
 * only cards that are still pending; an actual result always wins and keeps
 * its output/error state intact.
 */
function settlePendingTools(turn: ConversationTurn | undefined): void {
  if (!turn) return
  for (const segment of turn.segments) {
    if (segment.kind === "tool" && segment.status === "pending") {
      segment.status = "ok"
    }
  }
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

/**
 * Narrow an "agent-prompt" event's `options` into an `optionId -> label` map
 * — the same objects `normalizeOptions` flattens to a label list, kept
 * paired with their `optionId` this time so a later "permission-resolved"
 * record (which only carries the chosen `optionId`) can look its label back
 * up. Entries without a string `optionId` (or a plain-string option, which
 * has no id to key on) are dropped — they can't be correlated anyway.
 */
function normalizeOptionsById(raw: unknown): Record<string, string> | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: Record<string, string> = {}
  for (const o of raw) {
    if (!o || typeof o !== "object") continue
    const r = o as Record<string, unknown>
    const label = r.label ?? r.name ?? r.id ?? r.optionId
    if (typeof r.optionId === "string" && typeof label === "string") out[r.optionId] = label
  }
  return Object.keys(out).length > 0 ? out : undefined
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
  /** Pretty-printed, escaped tool input — CLAMPED to TOOL_IO_MAX_LINES. */
  argsText?: string
  /** True when argsText dropped lines: the full value is only in the editor. */
  argsClamped?: boolean
  /** Total line count of the full input, for the "open" affordance's label. */
  argsLines?: number
  /** Pretty-printed, escaped tool output — CLAMPED to TOOL_IO_MAX_LINES. */
  resultText?: string
  /** True when resultText dropped lines. */
  resultClamped?: boolean
  /** Total line count of the full output. */
  resultLines?: number
  isError: boolean
  status: "pending" | "ok" | "error"
  /** ISO timestamp the call opened — the webview's elapsed-time display for a pending call. */
  ts?: string
  /** True when this call was started with `run_in_background: true` (the
   *  daemon's `pendingBgTasks` heuristic, `@agentproto/runtime` sessions.ts
   *  `isBackgroundToolCallArguments` — mirrored here rather than imported
   *  since this module stays dependency-free). Only ever `true` or absent
   *  (never `false`) so an unset field never appears in a patch's diff. */
  background?: true
}

export interface PresentedPlanSegment {
  kind: "plan"
  id: string
  title?: string
  entries: PlanEntry[]
  done: number
  total: number
}

export interface PresentedQuestionSegment {
  kind: "agent-question"
  id: string
  options: string[]
  /** ACP tool-call id correlating this ask to its pending permission — the
   *  webview forwards it back when the user picks an option, so the host
   *  can call `permissions_respond` with the right daemon permission id. */
  toolCallId?: string
  /** optionId → display label for THIS ask's offered options — lets the
   *  webview resolve a clicked label back to its optionId so it can call
   *  `permissions_respond` without guessing. Absent for a legacy ask that
   *  predates the structured-options path. */
  optionsById?: Record<string, string>
  /** Set once this ask has been answered — see `QuestionSegment.resolved`.
   *  Absent means still awaiting a human/orchestrator decision. */
  resolved?: { decision: "approve" | "deny" | "cancelled"; optionId?: string; optionLabel?: string }
}

export interface PresentedErrorSegment {
  kind: "error"
  id: string
  /** Escaped error message. */
  text: string
}

/** What an activity group folds: the agent's working steps, never its conclusions. */
export type PresentedActivityChild = PresentedTextSegment | PresentedToolSegment

/**
 * A run of consecutive reasoning/tool steps folded into ONE collapsed row.
 *
 * A turn can spend minutes emitting thoughts and tool calls that a user
 * waiting on the final answer doesn't need to read — but may well want to
 * inspect. So the run collapses to a single line naming the CURRENT step and
 * expands to the full list on demand. Only reasoning and tool steps fold:
 * text, plans, questions and errors are conclusions or demand action, so they
 * stay visible at the top level and are never hidden behind a fold.
 */
export interface PresentedActivitySegment {
  kind: "activity"
  id: string
  /** The folded steps, in order. Never contains another activity. */
  children: PresentedActivityChild[]
  /** Collapsed-row text: the current step while pending, a step count once settled. */
  summary: string
  /** Number of folded steps. */
  count: number
  /** pending while a step is still in flight; error when any step errored. */
  status: "pending" | "ok" | "error"
  /** ISO ts the in-flight step opened — drives the collapsed row's elapsed ticker. */
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
  /**
   * ISO start time of the turn, when the reducer captured one. Purely a
   * host-side view-model field (carried through from `ConversationTurn`); no
   * daemon/protocol change. The "book" fold layer uses it to derive a
   * chapter's duration, and gracefully omits the duration when it's absent.
   */
  startedAt?: string
  /** Carried from `ConversationTurn.promptSource` — the book layer uses it
   *  to attribute an ask card to a supervisor instead of "you". */
  promptSource?: string
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
      segments: groupActivity(turn.segments.map(seg => presentSegment(seg, renderers))),
      ...(turn.startedAt !== undefined ? { startedAt: turn.startedAt } : {}),
      ...(turn.promptSource !== undefined ? { promptSource: turn.promptSource } : {}),
    })),
  }
}

/**
 * A lone step is left ungrouped: collapsed, it already occupies exactly one
 * row, so folding it would add a level of nesting and buy nothing.
 */
const MIN_ACTIVITY_GROUP = 2

function isActivityChild(seg: PresentedSegment): seg is PresentedActivityChild {
  return seg.kind === "reasoning" || seg.kind === "tool"
}

/**
 * Fold each run of consecutive reasoning/tool segments into one
 * PresentedActivitySegment. Order is preserved and nothing is dropped: every
 * input segment either survives at the top level or becomes a child of exactly
 * one group, so the fold is purely presentational and fully reversible.
 *
 * Pure and deterministic — the same segments always yield the same groups with
 * the same ids, which is what lets diffConversation's serialize-compare stay
 * honest across polls.
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
  // The in-flight step is normally the last one, but a result can land out of
  // order — find it rather than assuming position.
  const pending = children.find(
    (c): c is PresentedToolSegment => c.kind === "tool" && c.status === "pending",
  )
  const failed = children.filter(c => c.kind === "tool" && c.status === "error").length
  // The badge answers "how did this run END", not "did anything in it ever
  // fail". An agent running a command, having it fail, and adapting is not a
  // failed run — it is the normal shape of agent work, and stamping ✗ on six
  // steps because one of them was recovered from reports a failure that
  // didn't happen. The run only ends badly if its LAST step is the one that
  // failed and nothing followed it.
  //
  // Nothing is hidden by this: activitySummary still appends "· N failed", so
  // a settled run reads "6 steps · 1 failed" with a ✓ — the run finished, and
  // one step along the way went wrong. Both facts, in their right places.
  const last = children[children.length - 1]
  const endedOnFailure = last !== undefined && last.kind === "tool" && last.status === "error"
  const status: PresentedActivitySegment["status"] = pending
    ? "pending"
    : endedOnFailure
      ? "error"
      : "ok"
  return {
    kind: "activity",
    // Derived from the first child's id, which is seq-derived and stable — so
    // the group keeps its identity (and its expanded state) as steps are added.
    id: `act-${children[0]!.id}`,
    children,
    summary: activitySummary(children, pending, failed),
    count: children.length,
    status,
    ...(pending?.ts !== undefined ? { pendingSince: pending.ts } : {}),
  }
}

/** The collapsed row's text — what a waiting user reads without expanding. */
function activitySummary(
  children: readonly PresentedActivityChild[],
  pending: PresentedActivityChild | undefined,
  failed: number,
): string {
  const steps = `${children.length} step${children.length === 1 ? "" : "s"}`
  // Live: name the step actually running — that's the whole point of the row.
  if (pending) return `${stepLabel(pending)} · ${steps}`
  // Settled: a count, plus a failure tally so a fold never buries a failure.
  return failed > 0 ? `${steps} · ${failed} failed` : steps
}

function stepLabel(seg: PresentedActivityChild): string {
  if (seg.kind === "reasoning") return "Thinking"
  return seg.kind === "tool" ? (seg.toolName ?? "tool") : "Working"
}

/** Mirrors `@agentproto/runtime` sessions.ts `isBackgroundToolCallArguments` —
 *  matched generically on the `run_in_background` property, not the tool
 *  name, so any adapter/tool sharing the convention is picked up. */
function isBackgroundToolArguments(args: unknown): boolean {
  return (
    typeof args === "object" &&
    args !== null &&
    (args as Record<string, unknown>).run_in_background === true
  )
}

function presentSegment(seg: ConversationSegment, r: Renderers): PresentedSegment {
  switch (seg.kind) {
    case "user":
    case "assistant-text":
    case "reasoning":
      return { kind: seg.kind, id: seg.id, html: r.renderMarkdown(seg.text) }
    case "tool": {
      // Only the clamped preview is escaped and shipped. The full value never
      // crosses into the webview at all — when the user opens it, the host
      // re-derives it from its own conversation record (see the controller's
      // resolveToolIo), which keeps the "webview never holds raw daemon
      // content" contract intact for free.
      const args = seg.arguments === undefined ? undefined : clampToLines(stringifyToolValue(seg.arguments))
      const result = seg.result === undefined ? undefined : clampToLines(stringifyToolValue(seg.result))
      return {
        kind: "tool",
        id: seg.id,
        toolName: seg.toolName,
        ...(args
          ? { argsText: r.escapeHtml(args.preview), argsClamped: args.clamped, argsLines: args.lineCount }
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
        ...(seg.status === "pending" && isBackgroundToolArguments(seg.arguments) ? { background: true } : {}),
      }
    }
    case "plan":
      return { kind: "plan", id: seg.id, ...(seg.title ? { title: seg.title } : {}), entries: seg.entries, done: seg.done, total: seg.total }
    case "agent-question":
      return {
        kind: "agent-question",
        id: seg.id,
        options: seg.options,
        ...(seg.toolCallId ? { toolCallId: seg.toolCallId } : {}),
        ...(seg.optionsById ? { optionsById: seg.optionsById } : {}),
        ...(seg.resolved ? { resolved: seg.resolved } : {}),
      }
    case "error":
      return { kind: "error", id: seg.id, text: r.escapeHtml(seg.message) }
  }
}

/**
 * Compact, human-readable rendering of an arbitrary tool arg/result value.
 * Exported so the HOST can re-derive the identical text when opening the full
 * value in an editor — the webview only ever receives the clamped preview.
 */
export function stringifyToolValue(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** True when the value renders as JSON rather than plain text — decides the
 *  opened document's extension, hence its syntax highlighting. */
export function isJsonToolValue(value: unknown): boolean {
  return typeof value !== "string"
}

/**
 * How many lines of a tool's input/output the transcript shows inline.
 *
 * A tool card is a step in a story, not a log viewer. A 400-line test run or
 * a dumped file pushes every later message off the screen and buries the
 * thing the reader actually came for. Three lines is enough to recognize the
 * call and see how it opened; the full value is one click away in a real
 * editor, where search, folding and word-wrap already exist.
 */
export const TOOL_IO_MAX_LINES = 3

export interface ClampedText {
  /** The first `maxLines` lines, verbatim. */
  preview: string
  /** True when lines were dropped — i.e. there is provably more to open. */
  clamped: boolean
  /** Total line count of the full text. */
  lineCount: number
}

/**
 * Take the first `maxLines` lines.
 *
 * Deliberately line-based only. Horizontal overflow is left to CSS (the row
 * clips), because the host cannot know the panel's pixel width — so `clamped`
 * means precisely "lines were dropped", a claim this module can actually
 * prove. The rendered block stays clickable either way, so a single very long
 * line is never unreachable just because it is technically one line.
 */
export function clampToLines(text: string, maxLines: number = TOOL_IO_MAX_LINES): ClampedText {
  const lines = text.split("\n")
  // A trailing newline yields a final empty element that isn't a real line.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  const lineCount = lines.length
  if (lineCount <= maxLines) return { preview: lines.join("\n"), clamped: false, lineCount }
  return { preview: lines.slice(0, maxLines).join("\n"), clamped: true, lineCount }
}
