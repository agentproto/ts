import { describe, expect, it } from "vitest"

import {
  answerChoice,
  answerFreeText,
  answerPlan,
  modeChangedLabel,
  parseAgentPrompt,
} from "./agent-prompt"

const QUESTION_OPTIONS = [
  { optionId: "answer:0", name: "Yes", kind: "allow_once" },
  { optionId: "answer:1", name: "No", kind: "allow_once" },
  { optionId: "decline", name: "Decline to answer", kind: "reject_once" },
]

describe("parseAgentPrompt", () => {
  it("reads a missing request as a tool permission", () => {
    expect(parseAgentPrompt({ options: QUESTION_OPTIONS })).toBeUndefined()
  })

  it("reads an explicit tool-permission request as a tool permission", () => {
    expect(parseAgentPrompt({ request: "tool-permission", options: QUESTION_OPTIONS })).toBeUndefined()
  })

  it("reads an unknown request kind as a tool permission", () => {
    expect(parseAgentPrompt({ request: "telepathy", options: QUESTION_OPTIONS })).toBeUndefined()
  })

  it("parses a question with choices", () => {
    const view = parseAgentPrompt({
      request: "question",
      options: QUESTION_OPTIONS,
      question: {
        prompt: "Ship it?",
        choices: [
          { optionId: "answer:0", label: "Yes" },
          { optionId: "answer:1", label: "No", description: "keep working" },
        ],
        allowFreeText: false,
      },
    })
    expect(view).toEqual({
      request: "question",
      prompt: "Ship it?",
      choices: [
        { optionId: "answer:0", label: "Yes" },
        { optionId: "answer:1", label: "No", description: "keep working" },
      ],
    })
  })

  it("parses a free-text question", () => {
    const view = parseAgentPrompt({
      request: "question",
      options: [
        { optionId: "answer", name: "Answer", kind: "allow_once" },
        { optionId: "decline", name: "Decline to answer", kind: "reject_once" },
      ],
      question: { prompt: "Which branch?", choices: [], allowFreeText: true, freeTextOptionId: "answer" },
    })
    expect(view).toEqual({ request: "question", prompt: "Which branch?", choices: [], freeTextOptionId: "answer" })
  })

  it("parses a plan approval", () => {
    const view = parseAgentPrompt({
      request: "plan-approval",
      options: [
        { optionId: "approve", name: "Approve", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
      planApproval: {
        plan: "1. do it",
        planRef: "plans/p.md",
        targetModeId: "execute",
        approveOptionId: "approve",
        rejectOptionId: "reject",
      },
    })
    expect(view).toEqual({
      request: "plan-approval",
      plan: "1. do it",
      planRef: "plans/p.md",
      targetModeId: "execute",
      approveOptionId: "approve",
      rejectOptionId: "reject",
    })
  })

  it("falls back to a tool permission when the typed payload is missing or malformed", () => {
    expect(parseAgentPrompt({ request: "question", options: QUESTION_OPTIONS })).toBeUndefined()
    expect(parseAgentPrompt({ request: "plan-approval", planApproval: { plan: "x" } })).toBeUndefined()
    expect(
      parseAgentPrompt({ request: "question", question: { prompt: 3, choices: "no" }, options: QUESTION_OPTIONS }),
    ).toBeUndefined()
  })

  it("falls back when a plan approval names an option the prompt does not offer", () => {
    expect(
      parseAgentPrompt({
        request: "plan-approval",
        options: [{ optionId: "approve", name: "Approve", kind: "allow_once" }],
        planApproval: { plan: "x", approveOptionId: "approve", rejectOptionId: "reject" },
      }),
    ).toBeUndefined()
  })

  it("drops a choice the prompt does not offer, and a free-text option it does not offer", () => {
    const view = parseAgentPrompt({
      request: "question",
      options: [{ optionId: "answer:0", name: "Yes", kind: "allow_once" }],
      question: {
        prompt: "q",
        choices: [
          { optionId: "answer:0", label: "Yes" },
          { optionId: "ghost", label: "Ghost" },
        ],
        allowFreeText: true,
        freeTextOptionId: "nope",
      },
    })
    expect(view).toEqual({ request: "question", prompt: "q", choices: [{ optionId: "answer:0", label: "Yes" }] })
  })
})

describe("answers", () => {
  it("approves a chosen option by its id", () => {
    expect(answerChoice("answer:1")).toEqual({ decision: "approve", optionId: "answer:1" })
  })

  it("sends free text as feedback on the free-text option", () => {
    const view = parseAgentPrompt({
      request: "question",
      options: [{ optionId: "answer", name: "Answer", kind: "allow_once" }],
      question: { prompt: "q", choices: [], allowFreeText: true, freeTextOptionId: "answer" },
    })
    if (!view || view.request !== "question") throw new Error("expected a question")
    expect(answerFreeText(view, "  main  ")).toEqual({ decision: "approve", optionId: "answer", feedback: "main" })
    expect(answerFreeText(view, "   ")).toBeUndefined()
  })

  it("has no free-text answer when the question offers none", () => {
    expect(answerFreeText({ request: "question", prompt: "q", choices: [] }, "hi")).toBeUndefined()
  })

  it("approves a plan on its approve option, and rejects with optional feedback", () => {
    const view = {
      request: "plan-approval" as const,
      approveOptionId: "approve",
      rejectOptionId: "reject",
    }
    expect(answerPlan(view, "approve")).toEqual({ decision: "approve", optionId: "approve" })
    expect(answerPlan(view, "reject")).toEqual({ decision: "deny", optionId: "reject" })
    expect(answerPlan(view, "reject", "  too vague ")).toEqual({
      decision: "deny",
      optionId: "reject",
      feedback: "too vague",
    })
  })
})

describe("modeChangedLabel", () => {
  it("names the switch", () => {
    expect(modeChangedLabel({ modeId: "execute", previousModeId: "plan", cause: "caller" })).toBe(
      "Mode: plan -> execute",
    )
  })

  it("says by agent, and why", () => {
    expect(
      modeChangedLabel({ modeId: "execute", previousModeId: "plan", cause: "agent", reason: "plan approved" }),
    ).toBe("Mode: plan -> execute · by agent · plan approved")
  })

  it("copes with a missing previous mode", () => {
    expect(modeChangedLabel({ modeId: "plan", cause: "agent" })).toBe("Mode: plan · by agent")
  })
})
