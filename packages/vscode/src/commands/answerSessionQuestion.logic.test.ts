/**
 * Tests for answerSessionQuestion.logic.ts — the pure rules behind surfacing
 * a session's `awaitingQuestion` as one-click answers (quick-pick items,
 * recommended marking, the calm parked phrase).
 */

import { describe, expect, it } from "vitest"

import type { SessionDescriptor } from "../client/types.js"
import {
  AWAITING_WITHOUT_QUESTION_TEXT,
  awaitingStatusFor,
  hasAnswerableQuestion,
  questionOptionItems,
  questionQuickPickTitle,
  questionTooltipFor,
} from "./answerSessionQuestion.logic.js"

function session(over: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "s1",
    kind: "agent-cli",
    workspaceSlug: "ws",
    command: "claude-code --print",
    pid: 123,
    status: "running",
    startedAt: "2026-01-01T00:00:00Z",
    ...over,
  }
}

describe("awaitingStatusFor", () => {
  it("returns the question text verbatim", () => {
    expect(
      awaitingStatusFor(
        session({ awaitingInput: true, awaitingQuestion: { text: "Continue fresh?", source: "structured" } }),
      ),
    ).toBe("Continue fresh?")
  })
  it("treats blank question text as absent (never leads a row with whitespace)", () => {
    expect(
      awaitingStatusFor(session({ awaitingInput: true, awaitingQuestion: { text: "  ", source: "heuristic" } })),
    ).toBe(AWAITING_WITHOUT_QUESTION_TEXT)
  })
  it("falls back to the calm parked phrase when awaitingInput has no question", () => {
    expect(awaitingStatusFor(session({ awaitingInput: true }))).toBe(
      "idle, waiting for next prompt",
    )
  })
  it("returns undefined when the session isn't awaiting conversationally", () => {
    // Permission-parked sessions have their own tree and vocabulary.
    expect(awaitingStatusFor(session({ awaitingPermission: true }))).toBeUndefined()
    expect(awaitingStatusFor(session())).toBeUndefined()
  })
})

describe("hasAnswerableQuestion", () => {
  it("is false without options (nothing to one-click)", () => {
    expect(hasAnswerableQuestion(session({ awaitingInput: true, awaitingQuestion: { text: "?", source: "heuristic" } }))).toBe(false)
  })
  it("is true with an enumerated option set", () => {
    expect(
      hasAnswerableQuestion(
        session({ awaitingInput: true, awaitingQuestion: { text: "?", options: ["a", "b"], source: "structured" } }),
      ),
    ).toBe(true)
  })
})

describe("questionOptionItems", () => {
  it("emits the options verbatim and marks the recommended one", () => {
    const items = questionOptionItems({
      text: "Context is at 69%. Continue fresh to avoid losing continuity?",
      options: ["continue-fresh", "keep-going"],
      source: "structured",
      recommended: "continue-fresh",
    })
    expect(items).toEqual([
      { option: "continue-fresh", recommended: true, description: "Recommended", label: "$(check) continue-fresh" },
      { option: "keep-going", recommended: false, label: "keep-going" },
    ])
  })
  it("marks nothing when the daemon gives no recommendation", () => {
    const items = questionOptionItems({ text: "?", options: ["a", "b"], source: "structured" })
    expect(items.every(i => !i.recommended && i.description === undefined)).toBe(true)
  })
  it("marks nothing even when `recommended` isn't one of the options", () => {
    const items = questionOptionItems({
      text: "?",
      options: ["a", "b"],
      source: "structured",
      recommended: "c",
    })
    expect(items.every(i => !i.recommended)).toBe(true)
  })
  it("returns [] without a question and without options", () => {
    expect(questionOptionItems(undefined)).toEqual([])
    expect(questionOptionItems({ text: "?", source: "heuristic" })).toEqual([])
  })
})

describe("questionQuickPickTitle", () => {
  it("uses the question text, annotated for a heuristic guess", () => {
    expect(questionQuickPickTitle({ text: "Continue?", source: "structured" })).toBe("Continue?")
    expect(questionQuickPickTitle({ text: "Continue?", source: "heuristic" })).toBe(
      "Continue? (best-effort read of the transcript)",
    )
  })
  it("falls back to a generic title without text", () => {
    expect(questionQuickPickTitle(undefined)).toBe("Answer the question")
  })
})

describe("questionTooltipFor", () => {
  it("lists the options with the recommended check first when present", () => {
    const tip = questionTooltipFor(
      session({
        awaitingInput: true,
        awaitingQuestion: {
          text: "Context is at 69%. Continue fresh to avoid losing continuity?",
          options: ["continue-fresh", "handoff:gemini", "keep-going"],
          source: "structured",
          recommended: "continue-fresh",
        },
      }),
    )
    expect(tip).toContain(
      "Context is at 69%. Continue fresh to avoid losing continuity?\n\n$(check) continue-fresh (Recommended)\n· handoff:gemini\n· keep-going",
    )
  })
  it("is just the question text when there are no options", () => {
    expect(
      questionTooltipFor(session({ awaitingInput: true, awaitingQuestion: { text: "Name?", source: "heuristic" } })),
    ).toBe("Name?")
  })
  it("is the calm parked phrase for awaitingInput without a question", () => {
    expect(questionTooltipFor(session({ awaitingInput: true }))).toBe("idle, waiting for next prompt")
  })
  it("is undefined when the session is not awaiting input", () => {
    expect(questionTooltipFor(session())).toBeUndefined()
  })
})
