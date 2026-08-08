/**
 * Pure "book" segmentation over a presented conversation — the fold LEVEL
 * ABOVE turns/segments.
 *
 * A session reads as a BOOK, not a chat log: every user prompt closes the
 * previous chapter and opens a new one (with the user's message as the
 * chapter's opening "ask"), and a turn-end that isn't followed by a new prompt
 * closes the open chapter too. Those are the ONLY M0 boundaries —
 * user-prompt + turn-end — and they already fall out of the reducer's turn
 * grouping (`reduceConversation` opens a fresh assistant turn after each
 * turn-end and after each user prompt), so a chapter is just "an optional user
 * turn plus the assistant turn that answers it".
 *
 * This module REUSES the presented turns/segments verbatim — the same reducer
 * and step-group segmentation (`groupActivity`) the transcript view renders.
 * It only GROUPS them into chapters and derives fold-level metadata (origin,
 * outcome title, step tally, duration). No DOM, no `vscode`: unit-tested under
 * plain vitest, mirroring the other `.logic.ts` modules.
 *
 * Injection note: the transcript webview runs `buildBook` (and the small
 * helpers below) INSIDE the webview, where there's no module system — it
 * injects them by value via `.toString()` (see `buildHtml`'s `injectedHelpers`
 * in transcriptPanel.ts), the same trick used for the other pure helpers. That
 * only works when every function a helper calls is itself injected as a
 * sibling, so the otherwise-private helpers are `export`ed for injection rather
 * than folded into `buildBook`. `ASK_LONG_CHARS`/`TITLE_MAX_CHARS` are
 * interpolated as literals there.
 */

import type {
  PresentedActivitySegment,
  PresentedSegment,
  PresentedTextSegment,
  PresentedTurn,
} from "./conversation.js"

/** Who opened a chapter: a user prompt (`you`) or the agent itself (a
 *  turn-end split, with no ask). */
export type ChapterOrigin = "you" | "agent"

export interface ChapterAsk {
  /** The user's opening message — pre-escaped HTML, same value the transcript
   *  view renders for the user segment. */
  html: string
  /** True when the plaintext is long enough to warrant a "$ full message"
   *  expander (the card clamps until expanded). */
  long: boolean
}

export interface ChapterSteps {
  /** The agent's working steps (activity groups / tool / reasoning), in
   *  document order — rendered behind the "$ show N steps" fold by reusing the
   *  transcript's own segment renderer. */
  segments: PresentedSegment[]
  /** Leaf step count: an activity group counts by its own children, a lone
   *  tool/reasoning step as one. */
  count: number
  /** Steps that ended in error — the "· N failed" tally, matching the
   *  activity badge's own accounting. */
  failed: number
}

export interface BookChapter {
  /** Stable id derived from the chapter's opening turn — fold state keys off
   *  this, so it survives live updates. */
  id: string
  origin: ChapterOrigin
  /** Present only for a chapter opened by a user prompt. */
  ask?: ChapterAsk
  /** The agent's narration blocks (assistant-text), verbatim, in order. */
  narration: PresentedTextSegment[]
  steps: ChapterSteps
  /** Segments that must stay visible rather than fold behind steps — plans,
   *  errors, and pending questions (a failure renders a state; a question
   *  demands action). */
  notices: PresentedSegment[]
  /** Folded-row outcome title — the chapter's first narration sentence,
   *  trimmed. Never empty. */
  title: string
  /** ISO start of the opening turn, when the reducer captured one. */
  startedAt?: string
}

/** Plaintext length past which an ask card clamps and offers "$ full message". */
export const ASK_LONG_CHARS = 220
/** Folded-title length cap (the "~70 chars" in the spec). */
export const TITLE_MAX_CHARS = 70

/**
 * Group presented turns into book chapters. See the module header for the M0
 * boundary rules. Pure and deterministic: the same turns always yield the same
 * chapters with the same ids.
 */
export function buildBook(turns: readonly PresentedTurn[]): BookChapter[] {
  const chapters: BookChapter[] = []
  // The chapter currently accepting the next assistant turn, plus whether it
  // already has one (a user chapter accepts exactly one answering turn; a
  // second assistant turn opens its own agent chapter).
  let open: { chapter: BookChapter; hasWork: boolean } | undefined

  for (const turn of turns) {
    if (turn.role === "user") {
      const chapter = newChapter(turn, "you", askOf(turn))
      chapters.push(chapter)
      open = { chapter, hasWork: false }
      continue
    }
    // assistant turn
    if (open && open.chapter.origin === "you" && !open.hasWork) {
      fillChapter(open.chapter, turn)
      open.hasWork = true
    } else {
      const chapter = newChapter(turn, "agent", undefined)
      fillChapter(chapter, turn)
      chapters.push(chapter)
      open = { chapter, hasWork: true }
    }
  }

  for (const chapter of chapters) chapter.title = chapterTitle(chapter)
  return chapters
}

export function newChapter(turn: PresentedTurn, origin: ChapterOrigin, ask: ChapterAsk | undefined): BookChapter {
  return {
    id: turn.id,
    origin,
    ...(ask ? { ask } : {}),
    narration: [],
    steps: { segments: [], count: 0, failed: 0 },
    notices: [],
    title: "",
    ...(turn.startedAt !== undefined ? { startedAt: turn.startedAt } : {}),
  }
}

export function askOf(turn: PresentedTurn): ChapterAsk | undefined {
  const user = turn.segments.find(
    (s): s is PresentedTextSegment => s.kind === "user",
  )
  if (!user) return undefined
  return { html: user.html, long: htmlToText(user.html).length > ASK_LONG_CHARS }
}

/** Partition an assistant turn's segments into the chapter's narration,
 *  foldable steps, and always-visible notices. */
export function fillChapter(chapter: BookChapter, turn: PresentedTurn): void {
  for (const seg of turn.segments) {
    switch (seg.kind) {
      case "assistant-text":
        chapter.narration.push(seg)
        break
      case "activity":
        chapter.steps.segments.push(seg)
        chapter.steps.count += seg.count
        chapter.steps.failed += activityFailed(seg)
        break
      case "tool":
        chapter.steps.segments.push(seg)
        chapter.steps.count += 1
        if (seg.status === "error") chapter.steps.failed += 1
        break
      case "reasoning":
        chapter.steps.segments.push(seg)
        chapter.steps.count += 1
        break
      case "plan":
      case "error":
      case "agent-question":
        chapter.notices.push(seg)
        break
      // A stray "user" segment inside an assistant turn shouldn't happen; ignore.
    }
  }
}

/** Steps inside an activity group that ended in error — the same accounting
 *  the group's own "· N failed" summary uses (tool children with error). */
export function activityFailed(activity: PresentedActivitySegment): number {
  return activity.children.filter(c => c.kind === "tool" && c.status === "error").length
}

/**
 * The folded-row title: the first sentence of the chapter's first narration
 * block, trimmed to ~70 chars. Falls back to the ask's first sentence (a
 * chapter still streaming its answer), then to a generic marker — never empty.
 */
export function chapterTitle(chapter: BookChapter): string {
  const source =
    chapter.narration.length > 0
      ? htmlToText(chapter.narration[0]!.html)
      : chapter.ask
        ? htmlToText(chapter.ask.html)
        : ""
  const title = clampTitle(firstSentence(source))
  return title || "Working…"
}

/**
 * Strip a chapter duration from two adjacent chapters' start times — the gap
 * from this chapter's opening turn to the next chapter's. Returns undefined
 * for the last chapter (still open / unknown end) or when either timestamp is
 * missing or unparseable, so the caller can omit the duration rather than
 * invent one. Uses `Date.parse` (not `Date.now`) so it stays pure/testable.
 */
export function chapterDurationMs(chapters: readonly BookChapter[], index: number): number | undefined {
  const cur = chapters[index]?.startedAt
  const next = chapters[index + 1]?.startedAt
  if (cur === undefined || next === undefined) return undefined
  const a = Date.parse(cur)
  const b = Date.parse(next)
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return undefined
  return b - a
}

/** Compact duration for the fold row — "18s", "1m 04s", "1h 02m". */
export function formatChapterDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return totalSeconds + "s"
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return totalMinutes + "m " + pad2(totalSeconds % 60) + "s"
  const hours = Math.floor(totalMinutes / 60)
  return hours + "h " + pad2(totalMinutes % 60) + "m"
}

export function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n)
}

/**
 * Escaped HTML → plaintext. The presented html is already safe (escaped
 * markdown output), so this only has to undo tags and the handful of entities
 * markdown escaping produces, then collapse whitespace — enough to derive a
 * one-line title/length, not a general HTML parser.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
}

/** The first sentence of a one-line string: up to the first `.`/`!`/`?` that
 *  is followed by whitespace or the end, else the whole string. */
export function firstSentence(text: string): string {
  const match = text.match(/^.*?[.!?](?=\s|$)/)
  return (match ? match[0] : text).trim()
}

/** Trim a title to the cap, dropping a single trailing period for a cleaner
 *  headline, and appending an ellipsis when it was actually cut. */
export function clampTitle(sentence: string): string {
  const trimmed = sentence.replace(/\.$/, "")
  if (trimmed.length <= TITLE_MAX_CHARS) return trimmed
  return trimmed.slice(0, TITLE_MAX_CHARS - 1).trimEnd() + "…"
}
