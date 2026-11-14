/**
 * The pi extension that exposes agentproto's AIP-45 structured `question`
 * tool. pi loads this file via `pi -e <dist>/question-extension.mjs` (the
 * adapter adds the flag when `permissionHold` is set, see client.ts).
 *
 * The tool asks one to four structured questions through pi's extension UI
 * editor (`ctx.ui.editor`) and turns the host's answer into tool-result text
 * the model can read. The editor blocks until the client answers the
 * `extension_ui_request` over RPC; the adapter classifies that line, parks it
 * as an `agent-prompt` StreamEvent with `request: "question"`, and the host
 * resolves it through `AgentCliClient.respondPermission`.
 *
 * This module uses pi's structural runtime contract (a `registerTool` method;
 * a plain JSON Schema as `parameters`).
 */

import type { JsonObject, PiExtensionAPI, PiToolDefinition, PiToolResult } from "./mcp-bridge/types.js"
import type { AgentPromptQuestion } from "@agentproto/harness"

export const QUESTION_TOOL_NAME = "question"
export const QUESTION_ASK_TITLE = "agentproto.question/v1"
export const QUESTION_ASK_METHOD = "editor"
export const QUESTION_ANSWERS_KEY_PREFIX = "question_"

export const QUESTION_DESCRIPTION =
  "Ask the user one to four structured questions (single or multiple choice, free text always allowed); never ask in plain text when this tool exists."

export const QUESTION_PROMPT_SNIPPET = "Ask the user structured questions with the question tool."
export const QUESTION_PROMPT_GUIDELINES = [
  "Use the question tool for structured clarification instead of asking in chat prose.",
]

export const QUESTION_PARAMETERS: JsonObject = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          header: { type: "string" },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                description: { type: "string" },
              },
              required: ["label"],
            },
          },
          multiSelect: { type: "boolean" },
        },
        required: ["question", "options"],
      },
    },
  },
  required: ["questions"],
}

export interface QuestionOption {
  label: string
  description?: string
}

export interface Question {
  question: string
  header?: string
  options: QuestionOption[]
  multiSelect?: boolean
}

export interface QuestionAnswer {
  header?: string
  question: string
  selected: string[]
  text?: string
}

export interface QuestionResponse {
  answers?: QuestionAnswer[]
  skipped?: boolean
}

export interface QuestionChoice {
  value: string
  label: string
  description?: string
}

export interface QuestionField {
  id: string
  input: "single" | "multi"
  header?: string
  prompt: string
  choices?: QuestionChoice[]
  allowFreeText: boolean
  required: boolean
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseQuestions(prefill: string | undefined): Question[] {
  if (prefill === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(prefill)
  } catch {
    return []
  }
  const root = isRecordValue(parsed) ? parsed : {}
  const rawQuestions = Array.isArray(root["questions"]) ? (root["questions"] as unknown[]) : []
  const out: Question[] = []
  for (const entry of rawQuestions) {
    const rec = isRecordValue(entry) ? entry : {}
    const question = typeof rec["question"] === "string" ? (rec["question"] as string) : ""
    const header = typeof rec["header"] === "string" ? (rec["header"] as string) : undefined
    const rawOptions = Array.isArray(rec["options"]) ? (rec["options"] as unknown[]) : []
    const options: QuestionOption[] = []
    for (const rawOption of rawOptions) {
      const orec = isRecordValue(rawOption) ? rawOption : {}
      const label = typeof orec["label"] === "string" ? (orec["label"] as string) : ""
      const description = typeof orec["description"] === "string" ? (orec["description"] as string) : undefined
      options.push({ label, ...(description !== undefined ? { description } : {}) })
    }
    const multiSelect = rec["multiSelect"]
    out.push({
      question,
      ...(header !== undefined ? { header } : {}),
      options,
      ...(typeof multiSelect === "boolean" ? { multiSelect } : {}),
    })
  }
  return out
}

export function parseQuestionResponse(raw: unknown): QuestionResponse {
  const out: QuestionResponse = {}
  if (typeof raw !== "string") return out
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return out
  }
  const root = isRecordValue(parsed) ? parsed : {}
  if (Array.isArray(root["answers"])) {
    const answers = (root["answers"] as unknown[]).map((entry) => {
      const rec = isRecordValue(entry) ? entry : {}
      const selected = Array.isArray(rec["selected"]) ? (rec["selected"] as string[]) : []
      const text = typeof rec["text"] === "string" ? (rec["text"] as string) : undefined
      const header = typeof rec["header"] === "string" ? (rec["header"] as string) : undefined
      const question = typeof rec["question"] === "string" ? (rec["question"] as string) : ""
      const answer: QuestionAnswer = { header, question, selected }
      if (text !== undefined) answer.text = text
      return answer
    })
    out.answers = answers
  }
  if (root["skipped"] === true) out.skipped = true
  return out
}

export function buildQuestionFields(questions: readonly Question[]): QuestionField[] {
  const fields: QuestionField[] = []
  questions.forEach((q, i) => {
    fields.push({
      id: `${QUESTION_ANSWERS_KEY_PREFIX}${i}`,
      input: q.multiSelect === true ? "multi" : "single",
      ...(q.header !== undefined ? { header: q.header } : {}),
      prompt: q.question,
      choices: q.options.map((o) => ({
        value: o.label,
        label: o.label,
        ...(o.description !== undefined && o.description !== o.label ? { description: o.description } : {}),
      })),
      allowFreeText: true,
      required: false,
    })
  })
  return fields
}

export function formatQuestionAnswers(
  questions: readonly Question[],
  answers: readonly QuestionAnswer[] | undefined,
): string[] {
  const lines: string[] = []
  if (answers === undefined) return lines
  questions.forEach((q, i) => {
    const a = answers[i]
    if (a === undefined) return
    const picked = a.selected.filter((s) => q.options.some((o) => o.label === s))
    const value = picked.length > 0 ? picked.join(", ") : a.text ?? ""
    const trimmed = value.trim()
    if (trimmed === "") return
    const note =
      picked.length > 0 && a.text !== undefined && a.text.trim() !== "" ? ` (note: ${a.text.trim()})` : ""
    lines.push(`${q.header ?? q.question}: ${trimmed}${note}`)
  })
  return lines
}

export interface QuestionUiContext {
  ui: {
    editor: (title: string, prefill: string) => Promise<string | undefined>
  }
}

type QuestionExecute = (
  toolCallId: string,
  params: JsonObject,
  signal: AbortSignal | undefined,
  onUpdate: ((result: PiToolResult) => void) | undefined,
  ctx: QuestionUiContext,
) => Promise<PiToolResult>

function toQuestionList(params: JsonObject): Question[] {
  const raw = params["questions"]
  if (!Array.isArray(raw)) return []
  const out: Question[] = []
  for (const entry of raw) {
    const rec = isRecordValue(entry) ? entry : {}
    const question = typeof rec["question"] === "string" ? (rec["question"] as string) : ""
    const header = typeof rec["header"] === "string" ? (rec["header"] as string) : undefined
    const rawOptions = Array.isArray(rec["options"]) ? (rec["options"] as unknown[]) : []
    const options: QuestionOption[] = []
    for (const rawOption of rawOptions) {
      const orec = isRecordValue(rawOption) ? rawOption : {}
      const label = typeof orec["label"] === "string" ? (orec["label"] as string) : ""
      const description = typeof orec["description"] === "string" ? (orec["description"] as string) : undefined
      options.push({ label, ...(description !== undefined ? { description } : {}) })
    }
    const multiSelect = rec["multiSelect"]
    out.push({
      question,
      ...(header !== undefined ? { header } : {}),
      options,
      ...(typeof multiSelect === "boolean" ? { multiSelect } : {}),
    })
  }
  return out
}

export function questionTool(): PiToolDefinition {
  const execute = async (
    toolCallId: string,
    params: JsonObject,
    signal: AbortSignal | undefined,
    onUpdate: ((result: PiToolResult) => void) | undefined,
    ctx: QuestionUiContext,
  ): Promise<PiToolResult> => {
    void toolCallId
    void params
    void signal
    void onUpdate
    const questions = toQuestionList(params)
    const skippedText = "The user skipped the question."
    const raw = await ctx.ui.editor(QUESTION_ASK_TITLE, JSON.stringify({ questions }))
    if (raw === undefined) {
      return {
        content: [{ type: "text", text: skippedText }],
        details: { server: "agentproto", tool: QUESTION_TOOL_NAME, isError: false },
      }
    }
    const parsed = parseQuestionResponse(raw)
    const lines = formatQuestionAnswers(questions, parsed.answers)
    const text = lines.length > 0 ? lines.join("\n") : skippedText
    return {
      content: [{ type: "text", text }],
      details: { server: "agentproto", tool: QUESTION_TOOL_NAME, isError: false },
    }
  }
  const tool: PiToolDefinition = {
    name: QUESTION_TOOL_NAME,
    label: QUESTION_TOOL_NAME,
    description: QUESTION_DESCRIPTION,
    promptSnippet: QUESTION_PROMPT_SNIPPET,
    promptGuidelines: QUESTION_PROMPT_GUIDELINES,
    parameters: QUESTION_PARAMETERS,
    execute: execute as unknown as PiToolDefinition["execute"],
  }
  return tool
}

export default function questionExtension(pi: PiExtensionAPI): void {
  pi.registerTool(questionTool())
}
