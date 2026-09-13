import { describe, it, expect } from "vitest"
import { contentTeam } from "../content-team/index.js"
import { refKey } from "@agentproto/app-kit"

const fakeModel = { provider: "test", id: "test-model" }

describe("content-team app", () => {
  it("exposes stable app identity fields", () => {
    expect(contentTeam.id).toBe("@agentproto/content-team")
    expect(contentTeam.name).toBe("Content Team")
    expect(contentTeam.version).toBe("0.1.0")
  })

  it("bundles the four team agents bound to their production workflows", () => {
    expect(contentTeam.agents.map((a) => a.agent.id).sort()).toEqual([
      "@agentproto/editor",
      "@agentproto/illustrator",
      "@agentproto/researcher",
      "@agentproto/writer",
    ])
    expect(contentTeam.workflows.map((w) => w.id).sort()).toEqual(["produce-content", "produce-cover"])
    const bundledIds = new Set(contentTeam.workflows.map((w) => w.id))
    for (const { agent } of contentTeam.agents) {
      const refs = agent.workflows ?? []
      expect(refs.length).toBeGreaterThan(0)
      for (const ref of refs) {
        expect(bundledIds.has(refKey(ref))).toBe(true)
      }
    }
  })

  it("has the illustrator attached to the cover workflow", () => {
    const illustrator = contentTeam.agents.find((a) => a.agent.id === "@agentproto/illustrator")!
    const refs = illustrator.agent.workflows ?? []
    expect(refs.map((r) => refKey(r))).toContain("produce-cover")
  })

  it("builds every agent, each body becoming real Mastra instructions", async () => {
    const built = await contentTeam.toMastraAgents({ resolveModel: () => fakeModel })
    expect(Object.keys(built).sort()).toEqual([
      "@agentproto/editor",
      "@agentproto/illustrator",
      "@agentproto/researcher",
      "@agentproto/writer",
    ])
    expect(built["@agentproto/editor"]!.instructions).toContain("edit the draft")
    expect(built["@agentproto/illustrator"]!.instructions).toContain("One cover per article")
  })
})
