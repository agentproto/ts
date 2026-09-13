import { describe, it, expect } from "vitest"
import { codeTeam } from "../code-team/index.js"

const fakeModel = { provider: "test", id: "test-model" }

describe("code-team app", () => {
  it("exposes stable app identity fields", () => {
    expect(codeTeam.id).toBe("@agentproto/code-team")
    expect(codeTeam.name).toBe("Code Team")
    expect(codeTeam.version).toBe("0.1.0")
  })

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

  it("gives each agent the tools it needs to act (so it runs on mastra-agent)", () => {
    const byId = Object.fromEntries(codeTeam.agents.map((a) => [a.agent.id, a.agent]))
    // Reviewer is read-only: can inspect + run, but no write/edit capability.
    expect(byId["@agentproto/reviewer"]!.tools).toEqual(["list_dir", "read_file", "run_command"])
    // Implementer + fixer can edit files.
    expect(byId["@agentproto/implementer"]!.tools).toContain("edit_file")
    expect(byId["@agentproto/fixer"]!.tools).toContain("write_file")
  })

  it("lets a host use just one agent of the team", async () => {
    const built = await codeTeam.toMastraAgents({ resolveModel: () => fakeModel })
    expect(built["@agentproto/reviewer"]!.agent.name).toBe("reviewer")
  })

  it("delivers the change through three agent steps, one per team agent (WP-B4)", () => {
    const wf = codeTeam.workflows[0]!
    expect(wf.steps.map((s) => `${s.id}:${s.kind}`)).toEqual([
      "implement:agent",
      "review:agent",
      "fix:agent",
    ])
    const refs = wf.steps.map((s) => (s as { agent?: { ref: string } }).agent?.ref)
    expect(refs).toEqual(["@agentproto/implementer", "@agentproto/reviewer", "@agentproto/fixer"])
  })
})
