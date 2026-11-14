/**
 * Helpers for AIP-45 multi-field questions (`AgentPromptQuestion.fields`).
 * Pure and dependency-free so the daemon, the desktop app and the VS Code
 * webview can share one reading of an {@link AgentPromptAnswers} payload.
 */

import type { AgentPromptAnswers, AgentPromptField } from "./types.js"

/** `optionId` that submits a multi-field prompt (an `allow_once` option). */
export const QUESTION_SUBMIT_OPTION_ID = "submit"
/** `optionId` that skips a multi-field prompt (a `reject_once` option). */
export const QUESTION_SKIP_OPTION_ID = "skip"
/** Legacy `freeTextOptionId` of a prompt projected from one `single` field. */
export const QUESTION_FREE_TEXT_OPTION_ID = "other"
/** Legacy `optionId` of the `index`-th choice of a projected `single` field. */
export const questionChoiceOptionId = (index: number): string => `choice_${index}`

/** True when the answer carries anything at all (a pick, text, or a value). */
function isAnswered(answer: AgentPromptAnswers[string] | undefined): boolean {
  if (!answer) return false
  return (
    (answer.selected?.length ?? 0) > 0 ||
    (typeof answer.text === "string" && answer.text.trim() !== "") ||
    answer.value !== undefined
  )
}

/**
 * Check `answers` against `fields`. Returns a human-readable reason for the
 * first problem found, or `undefined` when the answers are acceptable: every
 * key names a field, picks are `choices[].value`s (at most one for
 * `single`), text on a choice field needs `allowFreeText`, `boolean` /
 * `number` values have the right type, and every `required` field is
 * answered.
 */
export function validateAgentPromptAnswers(
  fields: readonly AgentPromptField[],
  answers: AgentPromptAnswers,
): string | undefined {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return "answers must be an object keyed by field id"
  }
  const byId = new Map(fields.map(f => [f.id, f]))
  for (const [id, answer] of Object.entries(answers)) {
    const field = byId.get(id)
    if (!field) return `unknown field "${id}" (one of: ${fields.map(f => f.id).join(", ")})`
    if (!answer || typeof answer !== "object") return `answer for "${id}" must be an object`
    const { selected, text, value } = answer
    if (selected !== undefined && !(Array.isArray(selected) && selected.every(s => typeof s === "string"))) {
      return `"${id}".selected must be an array of strings`
    }
    if (text !== undefined && typeof text !== "string") return `"${id}".text must be a string`
    switch (field.input) {
      case "single":
      case "multi": {
        if (field.input === "single" && (selected?.length ?? 0) > 1) {
          return `"${id}" is single choice; select at most one value`
        }
        const values = new Set((field.choices ?? []).map(c => c.value))
        const bad = selected?.find(s => !values.has(s))
        if (bad !== undefined) return `"${id}" has no choice "${bad}"`
        if (text !== undefined && text.trim() !== "" && !field.allowFreeText) {
          return `"${id}" does not accept free text`
        }
        if (value !== undefined) return `"${id}" takes selected/text, not value`
        break
      }
      case "text":
        if (selected?.length) return `"${id}" is a text field; use text`
        if (value !== undefined) return `"${id}" is a text field; use text`
        break
      case "boolean":
        if (value !== undefined && typeof value !== "boolean") return `"${id}".value must be a boolean`
        if (selected?.length || text !== undefined) return `"${id}" is a boolean field; use value`
        break
      case "number": {
        if (value !== undefined && typeof value !== "number") return `"${id}".value must be a number`
        if (text !== undefined && text.trim() !== "" && !Number.isFinite(Number(text))) {
          return `"${id}".text is not a number`
        }
        if (selected?.length) return `"${id}" is a number field; use value`
        break
      }
    }
  }
  const missing = fields.find(f => f.required && !isAnswered(answers[f.id]))
  if (missing) return `field "${missing.id}" is required`
  return undefined
}

/**
 * One readable line for an answered prompt, e.g.
 * `Auth: OAuth; Features: Logs, Metrics, also tracing`. Picks are shown by
 * label. Skipped fields are left out; an empty result reads `(no answer)`.
 */
export function summarizeAgentPromptAnswers(
  fields: readonly AgentPromptField[],
  answers: AgentPromptAnswers,
): string {
  const parts: string[] = []
  for (const field of fields) {
    const answer = answers[field.id]
    if (!isAnswered(answer)) continue
    const items: string[] = []
    for (const v of answer!.selected ?? []) {
      items.push(field.choices?.find(c => c.value === v)?.label ?? v)
    }
    if (typeof answer!.text === "string" && answer!.text.trim() !== "") items.push(answer!.text.trim())
    if (answer!.value !== undefined) items.push(String(answer!.value))
    parts.push(`${field.header ?? field.prompt}: ${items.join(", ")}`)
  }
  return parts.length > 0 ? parts.join("; ") : "(no answer)"
}
