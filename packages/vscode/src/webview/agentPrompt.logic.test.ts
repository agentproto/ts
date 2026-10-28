import { describe, expect, it } from "vitest"

import {
  answerChoice,
  answerFreeText,
  answerPlan,
  modeChangedLabel,
  parseAgentPrompt,
} from "./agentPrompt.logic.js"

const QUESTION_OPTIONS = [
  { optionId: "answer:0", name: "Yes", kind: "allow_once" },
  { optionId: "answer:1", name: "No", kind: "allow_once" },
  { optionId: "decline", name: "Decline to answer", kind: "reject_once" },
]

describe("parseAgentPrompt", () => {
  it("reads a missing, explicit tool-permission or unknown request as a tool permission", () => {
    expect(parseAgentPrompt({ options: QUESTION_OPTIONS })).toBeUndefined()
    expect(parseAgentPrompt({ request: "tool-permission", options: QUESTION_OPTIONS })).toBeUndefined()
    expect(parseAgentPrompt({ request: "telepathy", options: QUESTION_OPTIONS })).toBeUndefined()
  })

  it("parses a question with choices", () => {
    expect(
      parseAgentPrompt({
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
      }),
    ).toEqual({
      request: "question",
      prompt: "Ship it?",
      choices: [
        { optionId: "answer:0", label: "Yes" },
        { optionId: "answer:1", label: "No", description: "keep working" },
      ],
    })
  })

  it("parses a free-text question", () => {
    expect(
      parseAgentPrompt({
        request: "question",
        options: [{ optionId: "answer", name: "Answer", kind: "allow_once" }],
        question: { prompt: "Which branch?", choices: [], allowFreeText: true, freeTextOptionId: "answer" },
      }),
    ).toEqual({ request: "question", prompt: "Which branch?", choices: [], freeTextOptionId: "answer" })
  })

  it("parses a plan approval", () => {
    expect(
      parseAgentPrompt({
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
      }),
    ).toEqual({
      request: "plan-approval",
      plan: "1. do it",
      planRef: "plans/p.md",
      targetModeId: "execute",
      approveOptionId: "approve",
      rejectOptionId: "reject",
    })
  })

  it("falls back to a tool permission on a missing or malformed typed payload", () => {
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

  it("drops a choice or free-text option the prompt does not offer", () => {
    expect(
      parseAgentPrompt({
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
      }),
    ).toEqual({ request: "question", prompt: "q", choices: [{ optionId: "answer:0", label: "Yes" }] })
  })
})

describe("answers", () => {
  it("approves a chosen option by its id", () => {
    expect(answerChoice("answer:1")).toEqual({ decision: "approve", optionId: "answer:1" })
  })

  it("sends free text as feedback on the free-text option, and nothing for blank text", () => {
    const view = { request: "question" as const, prompt: "q", choices: [], freeTextOptionId: "answer" }
    expect(answerFreeText(view, "  main  ")).toEqual({ decision: "approve", optionId: "answer", feedback: "main" })
    expect(answerFreeText(view, "   ")).toBeUndefined()
    expect(answerFreeText({ request: "question", prompt: "q", choices: [] }, "hi")).toBeUndefined()
  })

  it("approves a plan, and rejects it with optional feedback", () => {
    const view = { request: "plan-approval" as const, approveOptionId: "approve", rejectOptionId: "reject" }
    expect(answerPlan(view, "approve")).toEqual({ decision: "approve", optionId: "approve" })
    expect(answerPlan(view, "reject")).toEqual({ decision: "deny", optionId: "reject" })
    expect(answerPlan(view, "reject", " too vague ")).toEqual({
      decision: "deny",
      optionId: "reject",
      feedback: "too vague",
    })
  })
})

describe("modeChangedLabel", () => {
  it("names the switch, says by agent, and gives the reason", () => {
    expect(modeChangedLabel({ modeId: "execute", previousModeId: "plan", cause: "caller" })).toBe(
      "Mode: plan -> execute",
    )
    expect(
      modeChangedLabel({ modeId: "execute", previousModeId: "plan", cause: "agent", reason: "plan approved" }),
    ).toBe("Mode: plan -> execute · by agent · plan approved")
    expect(modeChangedLabel({ modeId: "plan", cause: "agent" })).toBe("Mode: plan · by agent")
  })
})
