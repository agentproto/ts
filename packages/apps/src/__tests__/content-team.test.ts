import { describe, it, expect } from "vitest"
import { contentTeam } from "../content-team/index.js"

const fakeModel = { provider: "test", id: "test-model" }

describe("content-team app", () => {
  it("bundles the three team agents bound to the production workflow", () => {
    expect(contentTeam.agents.map((a) => a.agent.id).sort()).toEqual([
      "@agentproto/editor",
      "@agentproto/researcher",
      "@agentproto/writer",
    ])
    expect(contentTeam.workflows.map((w) => w.id)).toEqual(["produce-content"])
    for (const { agent } of contentTeam.agents) {
      expect(agent.workflows).toContainEqual({ ref: "produce-content" })
    }
  })

  it("builds every agent, each body becoming real Mastra instructions", async () => {
    const built = await contentTeam.toMastraAgents({ resolveModel: () => fakeModel })
    expect(Object.keys(built).sort()).toEqual([
      "@agentproto/editor",
      "@agentproto/researcher",
      "@agentproto/writer",
    ])
    expect(built["@agentproto/editor"]!.instructions).toContain("edit the draft")
  })
})
