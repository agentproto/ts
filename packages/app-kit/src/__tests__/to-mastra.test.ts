import { describe, it, expect } from "vitest"
import { defineAgent } from "@agentproto/agent"
import { defineWorkflow } from "@agentproto/workflow"
import { defineApp, AppDefinitionError } from "../define-app.js"

// Fake AI-SDK-shaped model — Mastra accepts arbitrary objects on `model`
// as long as they satisfy generate/stream at call time; we only construct.
const fakeModel = { provider: "test", id: "test-model" }

const reviewerBody = "You are a rigorous reviewer. Report findings; change nothing."

function reviewWorkflow() {
  return defineWorkflow({
    id: "review-and-fix",
    name: "Review and fix",
    description: "Read the diff, report findings.",
    version: "0.1.0",
    inputs: {},
    outputs: {},
    steps: [{ id: "review", kind: "tool", tool: "read_diff" }],
  })
}

function multiAgentApp() {
  return defineApp({
    agents: [
      {
        agent: defineAgent({
          schema: "agent/v1",
          id: "@agentik/reviewer",
          description: "A PR reviewer.",
          model: "claude-sonnet-5",
          boundaries: ["Never run gh pr merge"],
          workflows: [{ ref: "review-and-fix" }],
        }),
        body: reviewerBody,
      },
      {
        agent: defineAgent({
          schema: "agent/v1",
          id: "fixer",
          description: "Applies fixes.",
          model: "claude-sonnet-5",
          workflows: [{ ref: "review-and-fix" }],
        }),
      },
    ],
    workflows: [reviewWorkflow()],
  })
}

describe("toMastraAgents — each body becomes real instructions", () => {
  it("builds every agent, keyed by id, with body → composed instructions", async () => {
    const built = await multiAgentApp().toMastraAgents({ resolveModel: () => fakeModel })

    expect(Object.keys(built).sort()).toEqual(["@agentik/reviewer", "fixer"])
    // reviewer's body leads its instructions; boundaries fold in.
    expect(built["@agentik/reviewer"]!.instructions).toContain(reviewerBody)
    expect(built["@agentik/reviewer"]!.instructions).toContain("Never run gh pr merge")
    // body-less fixer falls back to its description (composeInstructions).
    expect(built["fixer"]!.instructions).toContain("Applies fixes.")
    expect(built["@agentik/reviewer"]!.agent.name).toBe("reviewer")
  })

  it("toMastraAgent throws for a multi-agent app", async () => {
    await expect(
      multiAgentApp().toMastraAgent({ resolveModel: () => fakeModel }),
    ).rejects.toThrow(AppDefinitionError)
  })

  it("toMastraAgent works for a single-agent app and honors a body override", async () => {
    const app = defineApp({
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "solo",
            description: "One agent.",
            model: "claude-sonnet-5",
          }),
          body: reviewerBody,
        },
      ],
    })
    const overridden = await app.toMastraAgent({
      resolveModel: () => fakeModel,
      body: "Overridden body.",
    })
    expect(overridden.instructions).toContain("Overridden body.")
    expect(overridden.instructions).not.toContain(reviewerBody)
  })

  it("toMastraAgents with `only` builds just the named subset", async () => {
    const built = await multiAgentApp().toMastraAgents(
      { resolveModel: () => fakeModel },
      ["@agentik/reviewer"],
    )
    expect(Object.keys(built)).toEqual(["@agentik/reviewer"])
    expect(built["@agentik/reviewer"]!.instructions).toContain(reviewerBody)
  })

  it("`only` / `pick` throw on an agent id the app does not bundle", async () => {
    const app = multiAgentApp()
    expect(() => app.pick(["nope"])).toThrow(AppDefinitionError)
    await expect(
      app.toMastraAgents({ resolveModel: () => fakeModel }, ["nope"]),
    ).rejects.toThrow(AppDefinitionError)
  })

  it("`pick` returns the entries in the caller's order, without building", () => {
    const picked = multiAgentApp().pick(["fixer", "@agentik/reviewer"])
    expect(picked.map((e) => e.agent.id)).toEqual(["fixer", "@agentik/reviewer"])
  })
})
