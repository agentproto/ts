/**
 * ACP form elicitation (`elicitation/create`, `mode: "form"`) <-> AIP-45
 * multi-field question (`agent-prompt` with `question.fields`).
 *
 * The shapes follow what the harness wrappers actually send:
 * claude-agent-acp renders `AskUserQuestion` as one `question_<n>` property
 * per question (single select = string + `oneOf`, multi select = array +
 * `items.anyOf`) plus a `question_<n>_custom` string companion marked with
 * `_meta._askUserQuestionCustomAnswer` for the "Other" box; codex-acp uses
 * the same marker. Any other form (an MCP server's elicitation, a
 * refusal-fallback prompt) maps through the same generic rules.
 */

import type { AgentPromptAnswers, AgentPromptField, AgentPromptQuestion } from "../types.js"
import {
  QUESTION_FREE_TEXT_OPTION_ID,
  QUESTION_SKIP_OPTION_ID,
  QUESTION_SUBMIT_OPTION_ID,
  questionChoiceOptionId,
} from "../questions.js"

/** `_meta` key marking a string property as the free-text companion of a choice field. */
const CUSTOM_ANSWER_META_KEY = "_askUserQuestionCustomAnswer"
/** `_meta` key under which claude-agent-acp forwards an option's `preview`. */
const OPTION_PREVIEW_META_KEY = "_claude/askUserQuestionOption"

/** The value types an ACP elicitation `accept` may carry per property. */
export type ElicitationContentValue = string | number | boolean | string[]

export type ElicitationResponse =
  | { action: "accept"; content: Record<string, ElicitationContentValue> }
  | { action: "decline" }
  | { action: "cancel" }

/** A form elicitation mapped to a question, plus what it takes to answer it. */
export interface MappedElicitation {
  question: AgentPromptQuestion
  /** The event's `options`: submit + skip, plus the legacy projection's. */
  options: Array<{ optionId: string; name: string; kind: string }>
  /** Field id -> the companion property its free text goes back under. */
  companions: Map<string, string>
}

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined)

/** `{const,title,description,_meta}` (or a bare enum string) -> a choice. */
function toChoice(raw: unknown): NonNullable<AgentPromptField["choices"]>[number] | undefined {
  if (typeof raw === "string") return { value: raw, label: raw }
  if (!isObject(raw) || typeof raw.const !== "string") return undefined
  const description = str(raw.description)
  const meta = isObject(raw._meta) ? raw._meta : undefined
  const previewMeta = meta && isObject(meta[OPTION_PREVIEW_META_KEY]) ? meta[OPTION_PREVIEW_META_KEY] : undefined
  const preview = previewMeta ? str(previewMeta.preview) : undefined
  return {
    value: raw.const,
    label: str(raw.title) ?? raw.const,
    ...(description ? { description } : {}),
    ...(preview ? { preview } : {}),
  }
}

function choicesOf(list: unknown): AgentPromptField["choices"] | undefined {
  if (!Array.isArray(list)) return undefined
  const choices = list.map(toChoice).filter((c): c is NonNullable<typeof c> => c !== undefined)
  return choices.length > 0 ? choices : undefined
}

/** The field id a companion property points at, when it is one. */
function companionTarget(prop: Json): string | undefined {
  const meta = isObject(prop._meta) ? prop._meta : undefined
  const marker = meta && isObject(meta[CUSTOM_ANSWER_META_KEY]) ? meta[CUSTOM_ANSWER_META_KEY] : undefined
  return marker ? str(marker.questionId) : undefined
}

/**
 * Map a `mode: "form"` elicitation request to an AIP-45 question. Returns
 * `undefined` when the request has no schema properties we can render.
 */
export function elicitationToQuestion(params: unknown): MappedElicitation | undefined {
  const p = isObject(params) ? params : {}
  const message = str(p.message) ?? "The agent is asking for input."
  const schema = isObject(p.requestedSchema) ? p.requestedSchema : {}
  const properties = isObject(schema.properties) ? schema.properties : {}
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter(r => typeof r === "string") : [])

  // Pass 1: classify every property; companions are resolved once all
  // choice fields are known (the marker may precede its target).
  type Draft = { id: string; prop: Json; field?: Omit<AgentPromptField, "prompt" | "header"> }
  const drafts: Draft[] = []
  for (const [id, raw] of Object.entries(properties)) {
    if (!isObject(raw)) continue
    const type = raw.type
    let field: Draft["field"]
    if (type === "string") {
      const choices = choicesOf(raw.oneOf) ?? choicesOf(raw.enum)
      field = choices ? { id, input: "single", choices } : { id, input: "text" }
    } else if (type === "array") {
      const items = isObject(raw.items) ? raw.items : {}
      const choices = choicesOf(items.anyOf) ?? choicesOf(items.enum)
      if (choices) field = { id, input: "multi", choices }
    } else if (type === "boolean") {
      field = { id, input: "boolean" }
    } else if (type === "number" || type === "integer") {
      field = { id, input: "number" }
    }
    if (field) drafts.push({ id, prop: raw, field })
  }
  const companions = new Map<string, string>()
  const choiceIds = new Set(
    drafts.filter(d => d.field?.input === "single" || d.field?.input === "multi").map(d => d.id),
  )
  const visible = drafts.filter(d => {
    const target = d.field?.input === "text" ? companionTarget(d.prop) : undefined
    if (target && choiceIds.has(target) && !companions.has(target)) {
      companions.set(target, d.id)
      return false
    }
    return true
  })
  if (visible.length === 0) return undefined

  const fields: AgentPromptField[] = visible.map(({ id, prop, field }) => {
    const title = str(prop.title)
    const description = str(prop.description)
    // A lone field without its own description is the question `message`
    // asks (claude-agent-acp puts a single question there); its title is
    // then the short header chip.
    const prompt = description ?? (visible.length === 1 ? message : (title ?? message))
    const header = title && title !== prompt ? title : undefined
    return {
      ...field!,
      ...(header ? { header } : {}),
      prompt,
      ...(companions.has(id) ? { allowFreeText: true } : {}),
      ...(required.has(id) ? { required: true } : {}),
    }
  })

  const options: MappedElicitation["options"] = [
    { optionId: QUESTION_SUBMIT_OPTION_ID, name: "Submit", kind: "allow_once" },
    { optionId: QUESTION_SKIP_OPTION_ID, name: "Skip", kind: "reject_once" },
  ]
  const only = fields.length === 1 && fields[0]!.input === "single" ? fields[0]! : undefined
  const choices = (only?.choices ?? []).map((c, i) => ({
    optionId: questionChoiceOptionId(i),
    label: c.label,
    ...(c.description ? { description: c.description } : {}),
  }))
  for (const c of choices) options.push({ optionId: c.optionId, name: c.label, kind: "allow_once" })
  const allowFreeText = only?.allowFreeText === true
  if (allowFreeText) options.push({ optionId: QUESTION_FREE_TEXT_OPTION_ID, name: "Other", kind: "allow_once" })

  return {
    question: {
      prompt: message,
      choices,
      allowFreeText,
      ...(allowFreeText ? { freeTextOptionId: QUESTION_FREE_TEXT_OPTION_ID } : {}),
      fields,
    },
    options,
    companions,
  }
}

/** Rebuild the elicitation `accept` content from `answers`, field by field. */
export function answersToElicitationContent(
  mapped: Pick<MappedElicitation, "companions"> & { question: Pick<AgentPromptQuestion, "fields"> },
  answers: AgentPromptAnswers,
): Record<string, ElicitationContentValue> {
  const content: Record<string, ElicitationContentValue> = {}
  for (const field of mapped.question.fields ?? []) {
    const answer = answers[field.id]
    if (!answer) continue
    const text = typeof answer.text === "string" ? answer.text.trim() : ""
    const picks = (answer.selected ?? []).filter(v => field.choices?.some(c => c.value === v))
    switch (field.input) {
      case "single":
      case "multi": {
        if (picks.length > 0) content[field.id] = field.input === "single" ? picks[0]! : picks
        const companion = mapped.companions.get(field.id)
        if (companion && text !== "") content[companion] = text
        break
      }
      case "text":
        if (text !== "") content[field.id] = text
        break
      case "boolean":
        if (typeof answer.value === "boolean") content[field.id] = answer.value
        break
      case "number": {
        const n = typeof answer.value === "number" ? answer.value : text !== "" ? Number(text) : NaN
        if (Number.isFinite(n)) content[field.id] = n
        break
      }
    }
  }
  return content
}

/**
 * Turn a host's resolution of a held elicitation into the ACP response.
 * `{answers}` and the `submit` option accept, `skip` declines, a legacy
 * choice / free-text option accepts with that one answer, `{cancelled}`
 * cancels. Returns `undefined` for an option this prompt never offered.
 */
export function resolutionToElicitationResponse(
  mapped: MappedElicitation,
  resolution: { optionId: string; feedback?: string } | { answers: AgentPromptAnswers } | { cancelled: true },
): ElicitationResponse | undefined {
  if ("cancelled" in resolution) return { action: "cancel" }
  if ("answers" in resolution) {
    return { action: "accept", content: answersToElicitationContent(mapped, resolution.answers) }
  }
  const { optionId, feedback } = resolution
  if (optionId === QUESTION_SKIP_OPTION_ID) return { action: "decline" }
  const fields = mapped.question.fields ?? []
  const note = feedback?.trim() ? { text: feedback } : {}
  if (optionId === QUESTION_SUBMIT_OPTION_ID) {
    // A bare submit carries nothing but, maybe, feedback: hand it to the
    // first field that takes free text.
    const target = fields.find(f => f.allowFreeText || f.input === "text")
    return {
      action: "accept",
      content: answersToElicitationContent(mapped, target && feedback?.trim() ? { [target.id]: note } : {}),
    }
  }
  const only = fields.length === 1 && fields[0]!.input === "single" ? fields[0]! : undefined
  if (!only) return undefined
  if (optionId === QUESTION_FREE_TEXT_OPTION_ID && only.allowFreeText) {
    return { action: "accept", content: answersToElicitationContent(mapped, { [only.id]: note }) }
  }
  const index = (only.choices ?? []).findIndex((_, i) => questionChoiceOptionId(i) === optionId)
  if (index < 0) return undefined
  return {
    action: "accept",
    content: answersToElicitationContent(mapped, {
      [only.id]: { selected: [only.choices![index]!.value], ...note },
    }),
  }
}
