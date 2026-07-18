import { describe, it, expect } from "vitest"
import { defineAgent } from "@agentproto/agent"
import { defineWorkflow } from "@agentproto/workflow"
import { defineApp, AppDefinitionError } from "../define-app.js"

const systemPrompt = "You are a rigorous reviewer. Report findings, change nothing."

function reviewer(workflows: { ref: string }[] = [{ ref: "review-and-fix" }]) {
  return defineAgent({
    schema: "agent/v1",
    id: "@agentik/reviewer",
    description: "A PR reviewer agent bundled with its review workflow.",
    model: "claude-sonnet-5",
    workflows,
  })
}

function reviewWorkflow(id = "review-and-fix") {
  return defineWorkflow({
    id,
    name: "Review and fix",
    description: "Read the diff, report findings.",
    version: "0.1.0",
    inputs: {},
    outputs: {},
    steps: [{ id: "review", kind: "tool", tool: "read_diff" }],
  })
}

describe("defineApp — attachment invariant", () => {
  it("builds a frozen handle when agent ⇄ workflows match exactly", () => {
    const app = defineApp({
      agent: reviewer(),
      systemPrompt,
      workflows: [reviewWorkflow()],
    })
    expect(app.agent.id).toBe("@agentik/reviewer")
    expect(app.systemPrompt).toBe(systemPrompt)
    expect(app.workflows).toHaveLength(1)
    expect(Object.isFrozen(app)).toBe(true)
    expect(Object.isFrozen(app.workflows)).toBe(true)
  })

  it("accepts an app with no workflows and no workflow refs", () => {
    const app = defineApp({
      agent: reviewer([]),
      systemPrompt,
    })
    expect(app.workflows).toHaveLength(0)
  })

  it("throws when the agent references a workflow the app does not bundle", () => {
    expect(() =>
      defineApp({
        agent: reviewer([{ ref: "ghost-workflow" }]),
        systemPrompt,
        workflows: [reviewWorkflow()],
      }),
    ).toThrow(AppDefinitionError)
  })

  it("throws when a bundled workflow is not listed by the agent (orphan)", () => {
    expect(() =>
      defineApp({
        agent: reviewer([]),
        systemPrompt,
        workflows: [reviewWorkflow()],
      }),
    ).toThrow(/orphan|does not list/i)
  })

  it("throws on a duplicate workflow id in the bundle", () => {
    expect(() =>
      defineApp({
        agent: reviewer([{ ref: "review-and-fix" }]),
        systemPrompt,
        workflows: [reviewWorkflow(), reviewWorkflow()],
      }),
    ).toThrow(/duplicate/i)
  })

  it("requires a non-empty systemPrompt", () => {
    expect(() =>
      defineApp({ agent: reviewer([]), systemPrompt: "" }),
    ).toThrow(AppDefinitionError)
  })

  it("matches string and { ref } workflow refs by the same key", () => {
    const app = defineApp({
      agent: defineAgent({
        schema: "agent/v1",
        id: "@agentik/reviewer",
        description: "Uses a bare-string workflow ref.",
        model: "claude-sonnet-5",
        workflows: ["review-and-fix"],
      }),
      systemPrompt,
      workflows: [reviewWorkflow()],
    })
    expect(app.workflows[0]!.id).toBe("review-and-fix")
  })
})
