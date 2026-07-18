import { describe, it, expect } from "vitest"
import { codeTeam } from "../code-team/index.js"

const fakeModel = { provider: "test", id: "test-model" }

describe("code-team app", () => {
  it("bundles the three team agents bound to the delivery workflow", () => {
    expect(codeTeam.agents.map((a) => a.agent.id).sort()).toEqual([
      "@agentproto/fixer",
      "@agentproto/implementer",
      "@agentproto/reviewer",
    ])
    expect(codeTeam.workflows.map((w) => w.id)).toEqual(["deliver-change"])
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
    expect(built["@agentproto/reviewer"]!.instructions).toContain("Never run gh pr merge")
  })

  it("lets a host use just one agent of the team", async () => {
    const built = await codeTeam.toMastraAgents({ resolveModel: () => fakeModel })
    expect(built["@agentproto/reviewer"]!.agent.name).toBe("reviewer")
  })
})
