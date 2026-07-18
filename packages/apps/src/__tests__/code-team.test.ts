import { describe, it, expect } from "vitest"
import { codeTeam } from "../code-team.js"

const fakeModel = { provider: "test", id: "test-model" }

describe("code-team app", () => {
  it("bundles the three team agents bound to the delivery workflow", () => {
    expect(codeTeam.agents.map((a) => a.agent.id).sort()).toEqual([
      "@agentproto/fixer",
      "@agentproto/implementer",
      "@agentproto/reviewer",
    ])
    expect(codeTeam.workflows.map((w) => w.id)).toEqual(["deliver-change"])
    // Every agent references the one bundled workflow (attachment invariant).
    for (const { agent } of codeTeam.agents) {
      expect(agent.workflows).toContainEqual({ ref: "deliver-change" })
    }
  })

  it("builds every agent, each body becoming real Mastra instructions", async () => {
    const built = await codeTeam.toMastraAgents({ resolveModel: () => fakeModel })
    expect(Object.keys(built).sort()).toEqual([
      "@agentproto/fixer",
      "@agentproto/implementer",
      "@agentproto/reviewer",
    ])
    expect(built["@agentproto/reviewer"]!.instructions).toContain("rigorous reviewer")
    // The reviewer's boundary folds into its instructions.
    expect(built["@agentproto/reviewer"]!.instructions).toContain("Never run gh pr merge")
  })

  it("lets a host use just one agent of the team", async () => {
    // The "use n agents from a team" path: build all, pick one by id.
    const built = await codeTeam.toMastraAgents({ resolveModel: () => fakeModel })
    const reviewerOnly = built["@agentproto/reviewer"]
    expect(reviewerOnly).toBeDefined()
    expect(reviewerOnly!.agent.name).toBe("reviewer")
  })
})
