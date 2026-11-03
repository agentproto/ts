import { describe, it, expect } from "vitest"

import { elicitationToQuestion, answersToElicitationContent } from "../client/elicitation.js"
import { summarizeAgentPromptAnswers, validateAgentPromptAnswers } from "../questions.js"
import type { AgentPromptField } from "../types.js"
import { ASK_TWO } from "./fixtures/claude-agent-acp-elicitation.js"

describe("elicitationToQuestion, generic MCP forms", () => {
  const form = {
    mode: "form",
    sessionId: "s",
    message: "Configure the server",
    requestedSchema: {
      type: "object",
      required: ["port"],
      properties: {
        region: { type: "string", title: "Region", enum: ["eu", "us"] },
        name: { type: "string", title: "Name", description: "Display name" },
        verbose: { type: "boolean", title: "Verbose" },
        port: { type: "integer", title: "Port" },
      },
    },
  }

  it("maps enum, text, boolean and number properties, with required", () => {
    const mapped = elicitationToQuestion(form)!
    expect(mapped.question.fields).toEqual([
      { id: "region", input: "single", prompt: "Region", choices: [{ value: "eu", label: "eu" }, { value: "us", label: "us" }] },
      { id: "name", input: "text", header: "Name", prompt: "Display name" },
      { id: "verbose", input: "boolean", prompt: "Verbose" },
      { id: "port", input: "number", prompt: "Port", required: true },
    ])
    // Several fields: no legacy projection even though one is single.
    expect(mapped.question.choices).toEqual([])
    expect(
      answersToElicitationContent(mapped, {
        region: { selected: ["us"] },
        name: { text: " web " },
        verbose: { value: true },
        port: { text: "8080" },
      }),
    ).toEqual({ region: "us", name: "web", verbose: true, port: 8080 })
  })

  it("returns undefined for a form with nothing renderable", () => {
    expect(elicitationToQuestion({ mode: "form", message: "x", requestedSchema: { properties: {} } })).toBeUndefined()
  })
})

describe("validateAgentPromptAnswers / summarizeAgentPromptAnswers", () => {
  const fields = elicitationToQuestion(ASK_TWO)!.question.fields as AgentPromptField[]

  it("accepts a well-formed answer and summarizes it by label", () => {
    const answers = { question_0: { selected: ["SQLite"] }, question_1: { selected: ["Logs"], text: "profiles" } }
    expect(validateAgentPromptAnswers(fields, answers)).toBeUndefined()
    expect(summarizeAgentPromptAnswers(fields, answers)).toBe("Database: SQLite; Features: Logs, profiles")
    expect(summarizeAgentPromptAnswers(fields, {})).toBe("(no answer)")
  })

  it("rejects unknown fields, unknown choices and two picks on a single field", () => {
    expect(validateAgentPromptAnswers(fields, { nope: {} })).toMatch(/unknown field "nope"/)
    expect(validateAgentPromptAnswers(fields, { question_0: { selected: ["Oracle"] } })).toMatch(/no choice "Oracle"/)
    expect(validateAgentPromptAnswers(fields, { question_0: { selected: ["SQLite", "Postgres"] } })).toMatch(
      /at most one/,
    )
  })

  it("enforces required and free-text rules", () => {
    const strict: AgentPromptField[] = [
      { id: "a", input: "single", prompt: "A", choices: [{ value: "x", label: "X" }], required: true },
    ]
    expect(validateAgentPromptAnswers(strict, {})).toMatch(/"a" is required/)
    expect(validateAgentPromptAnswers(strict, { a: { text: "typed" } })).toMatch(/does not accept free text/)
  })
})
