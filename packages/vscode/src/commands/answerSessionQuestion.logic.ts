/**
 * Pure logic for surfacing a session's `awaitingQuestion` (the daemon's
 * `SessionAwaitingQuestion` — a context-continuity fork, an agent question or
 * a structured prompt) as one-click answers. NO vscode import — the command
 * in answerSessionQuestion.ts wraps these into a QuickPick and the tree /
 * webview rows reuse the same option-item shape.
 */

import type { SessionDescriptor, SessionAwaitingQuestion } from "../client/types.js"

/**
 * The row text for a session that flagged `awaitingInput` but carries NO
 * question. The amber "!" glyph means "blocked ON THE HUMAN"; without a
 * question that read is pure alarm — the session simply finished its turn
 * and is parked, perfectly ready for the next prompt. This is the calm,
 * truthful phrase those rows render (tree description lead and icon instead
 * of the loud question glyph) instead of the previously silent "!".
 */
export const AWAITING_WITHOUT_QUESTION_TEXT = "idle, waiting for next prompt"

/**
 * The question a session is paused on, or the calm parked phrase when it is
 * awaiting input with none, or undefined when the session isn't awaiting the
 * human conversationally at all (`awaitingInput` false, or it is only
 * `awaitingPermission` — parked permission requests have their own tree and
 * vocabulary, `agentproto.permissions ls` / permissionsTree).
 */
export function awaitingStatusFor(
  session: Pick<SessionDescriptor, "awaitingInput" | "awaitingQuestion" | "awaitingPermission">,
): string | undefined {
  if (session.awaitingInput !== true) return undefined
  const text = session.awaitingQuestion?.text?.trim()
  if (text) return text
  return AWAITING_WITHOUT_QUESTION_TEXT
}

/**
 * One clickable answer for a question — the exact string the daemon listed in
 * `options` (it is also the exact string posted through the normal prompt
 * path — `POST /sessions/:id/prompt`), plus the recommended flag so both the
 * QuickPick and the webview buttons can mark the daemon's own recommendation
 * (`SessionAwaitingQuestion.recommended`, exact case-sensitive match).
 */
export interface QuestionOptionItem {
  /** The option string, verbatim — what gets sent as the prompt. */
  option: string
  /** QuickPick label with the check marker for the recommended option. */
  label: string
  /** "Recommended" when this is the daemon's pick, else undefined. */
  description?: string
  recommended: boolean
}

/** The marker prepending the recommended option's label. */
export const RECOMMENDED_MARKER = "$(check)"

export function questionOptionItems(question: SessionAwaitingQuestion | undefined): QuestionOptionItem[] {
  const options = question?.options ?? []
  if (options.length === 0) return []
  const recommended = question?.recommended
  return options.map(option => {
    const isRecommended = typeof recommended === "string" && recommended === option
    return {
      option,
      recommended: isRecommended,
      ...(isRecommended ? { description: "Recommended" } : {}),
      label: isRecommended ? `${RECOMMENDED_MARKER} ${option}` : option,
    }
  })
}

/**
 * The QuickPick question line — the daemon's question text (which usually
 * already ends in "?") plus a source hint when the question is a heuristic
 * guess, so the operator knows it's not authoritative. Falls back to a bare
 * "Answer" title when there's no text.
 */
export function questionQuickPickTitle(question: SessionAwaitingQuestion | undefined): string {
  const text = question?.text?.trim()
  if (!text) return "Answer the question"
  return question?.source === "heuristic" ? `${text} (best-effort read of the transcript)` : text
}

/**
 * The tooltip line for a session sitting on a question — the readable "why it
 * waits" for the tree row. Options are listed in order, the recommended one
 * first with its marker, exactly matching the one-click list.
 */
export function questionTooltipFor(session: SessionDescriptor): string | undefined {
  if (session.awaitingQuestion) {
    const question = session.awaitingQuestion
    const items = questionOptionItems(question)
    if (items.length === 0) return question.text
    const lines = items.map(
      item => `${item.recommended ? RECOMMENDED_MARKER : "·"} ${item.description ? `${item.option} (${item.description})` : item.option}`,
    )
    return `${question.text}\n\n${lines.join("\n")}`
  }
  if (session.awaitingInput === true) return AWAITING_WITHOUT_QUESTION_TEXT
  return undefined
}
