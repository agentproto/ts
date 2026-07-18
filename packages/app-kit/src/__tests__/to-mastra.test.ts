import { describe, it, expect } from "vitest"
import { defineAgent } from "@agentproto/agent"
import { defineWorkflow } from "@agentproto/workflow"
import { defineApp } from "../define-app.js"

// Fake AI-SDK-shaped model — Mastra accepts arbitrary objects on `model`
// as long as they satisfy generate/stream at call time; we only construct.
const fakeModel = { provider: "test", id: "test-model" }

const systemPrompt = "You are a rigorous reviewer. Report findings; change nothing."

function buildApp() {
  return defineApp({
    agent: defineAgent({
      schema: "agent/v1",
      id: "@agentik/reviewer",
      description: "A PR reviewer agent bundled with its review workflow.",
      model: "claude-sonnet-5",
      boundaries: ["Never run gh pr merge"],
      workflows: [{ ref: "review-and-fix" }],
    }),
    systemPrompt,
    workflows: [
      defineWorkflow({
        id: "review-and-fix",
        name: "Review and fix",
        description: "Read the diff, report findings.",
        version: "0.1.0",
        inputs: {},
        outputs: {},
        steps: [{ id: "review", kind: "tool", tool: "read_diff" }],
      }),
    ],
  })
}

describe("toMastraAgent — the system prompt becomes real instructions", () => {
  it("injects systemPrompt as the AGENT.md body → composed instructions", async () => {
    const app = buildApp()
    const result = await app.toMastraAgent({ resolveModel: () => fakeModel })

    expect(result.agent).toBeDefined()
    expect(result.agent.name).toBe("reviewer")
    // systemPrompt (the AGENT.md body) leads the composed instructions.
    expect(result.instructions).toContain(systemPrompt)
    // boundaries fold in as hard rules.
    expect(result.instructions).toContain("Never run gh pr merge")
  })

  it("lets the caller override the body explicitly", async () => {
    const app = buildApp()
    const result = await app.toMastraAgent({
      resolveModel: () => fakeModel,
      body: "Overridden prompt body.",
    })
    expect(result.instructions).toContain("Overridden prompt body.")
    expect(result.instructions).not.toContain(systemPrompt)
  })
})
