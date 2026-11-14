import { describe, expect, it } from "vitest"

import {
  answerFields,
  emptyDrafts,
  missingRequired,
  parseAgentPrompt,
  skipQuestion,
  toggleChoice,
  type AgentPromptInput,
} from "./agent-prompt"
import { questionView } from "./session-view"
import type { SessionDescriptor } from "./types"

// The `agent-prompt` the daemon relays for claude-agent-acp's two-question
// AskUserQuestion form (single select + multiSelect, each with "Other").
const TWO_QUESTIONS: AgentPromptInput = {
  request: "question",
  options: [
    { optionId: "submit", name: "Submit", kind: "allow_once" },
    { optionId: "skip", name: "Skip", kind: "reject_once" },
  ],
  question: {
    prompt: "Please answer the following questions.",
    choices: [],
    allowFreeText: false,
    fields: [
      {
        id: "question_0",
        input: "single",
        header: "Database",
        prompt: "Which database should we use?",
        choices: [
          { value: "Postgres", label: "Postgres", description: "Relational, battle tested" },
          { value: "SQLite", label: "SQLite", preview: "db.sqlite" },
        ],
        allowFreeText: true,
      },
      {
        id: "question_1",
        input: "multi",
        header: "Features",
        prompt: "Which features do you want?",
        choices: [
          { value: "Logs", label: "Logs" },
          { value: "Traces", label: "Traces" },
        ],
        allowFreeText: true,
      },
      { id: "broken", input: "single", prompt: "No choices" },
    ],
  },
}

describe("parseAgentPrompt with fields", () => {
  it("reads the fields and drops malformed ones", () => {
    const view = parseAgentPrompt(TWO_QUESTIONS)
    expect(view?.request).toBe("question")
    const fields = view?.request === "question" ? view.fields : undefined
    expect(fields?.map((f) => [f.id, f.input, f.header, f.allowFreeText, f.choices.length])).toEqual([
      ["question_0", "single", "Database", true, 2],
      ["question_1", "multi", "Features", true, 2],
    ])
    expect(fields?.[0]?.choices[1]).toEqual({ value: "SQLite", label: "SQLite", preview: "db.sqlite" })
  })

  it("leaves fields absent on a legacy question", () => {
    const view = parseAgentPrompt({ request: "question", question: { prompt: "Q?", choices: [], allowFreeText: false } })
    expect(view?.request === "question" && view.fields).toBeFalsy()
  })
})

describe("answering fields", () => {
  const view = parseAgentPrompt(TWO_QUESTIONS)
  const fields = view?.request === "question" ? view.fields! : []

  it("radio replaces, checkbox toggles, and answers carry picks plus Other text", () => {
    let drafts = emptyDrafts(fields)
    const [single, multi] = fields
    drafts = { ...drafts, question_0: toggleChoice(single!, drafts.question_0!, "Postgres") }
    drafts = { ...drafts, question_0: toggleChoice(single!, drafts.question_0!, "SQLite") }
    drafts = { ...drafts, question_1: toggleChoice(multi!, drafts.question_1!, "Logs") }
    drafts = { ...drafts, question_1: toggleChoice(multi!, drafts.question_1!, "Traces") }
    drafts = { ...drafts, question_1: toggleChoice(multi!, drafts.question_1!, "Logs") }
    drafts = { ...drafts, question_1: { ...drafts.question_1!, text: " profiles " } }
    expect(answerFields(fields, drafts)).toEqual({
      decision: "approve",
      answers: { question_0: { selected: ["SQLite"] }, question_1: { selected: ["Traces"], text: "profiles" } },
    })
  })

  it("skips blank fields, enforces required, and skip is a deny", () => {
    expect(answerFields(fields, emptyDrafts(fields))).toEqual({ decision: "approve", answers: {} })
    const required = [{ ...fields[0]!, required: true }]
    expect(missingRequired(required, emptyDrafts(required))?.id).toBe("question_0")
    expect(skipQuestion()).toEqual({ decision: "deny" })
  })
})

describe("questionView", () => {
  it("leaves a multi-field harness question to the permission banner", () => {
    const base = { id: "s", status: "running" } as unknown as SessionDescriptor
    expect(questionView({ ...base, awaitingQuestion: { text: "Q?", options: ["A"], source: "structured" } })).toEqual({
      text: "Q?",
      options: ["A"],
    })
    expect(
      questionView({ ...base, awaitingQuestion: { text: "Q?", options: ["A"], source: "structured", requestId: "perm_1" } }),
    ).toBeNull()
  })
})
