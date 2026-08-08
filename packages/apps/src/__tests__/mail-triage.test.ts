import { describe, it, expect } from "vitest"
import { mailTriage } from "../mail-triage/index.js"

const fakeModel = { provider: "test", id: "test-model" }

describe("mail-triage app", () => {
  it("bundles the single triager agent bound to the triage-inbox workflow", () => {
    expect(mailTriage.agents.map((a) => a.agent.id)).toEqual(["@agentproto/triager"])
    expect(mailTriage.workflows.map((w) => w.id)).toEqual(["triage-inbox"])
    for (const { agent } of mailTriage.agents) {
      expect(agent.workflows).toContainEqual({ ref: "triage-inbox" })
    }
  })

  it("builds the agent, its body becoming real Mastra instructions", async () => {
    const built = await mailTriage.toMastraAgents({ resolveModel: () => fakeModel })
    expect(Object.keys(built)).toEqual(["@agentproto/triager"])
    expect(built["@agentproto/triager"]!.instructions).toContain("triage")
    expect(built["@agentproto/triager"]!.agent.name).toBe("triager")
  })

  it("gives the triager the tools it needs to scan and act on the inbox", () => {
    const byId = Object.fromEntries(mailTriage.agents.map((a) => [a.agent.id, a.agent]))
    expect(byId["@agentproto/triager"]!.tools).toEqual([
      "mailbox_list",
      "mailbox_search",
      "mailbox_list_threads",
      "mailbox_get_thread",
      "mailbox_labels_list",
      "mailbox_label_create",
      "mailbox_triage_plan",
      "mailbox_triage_apply",
    ])
  })

  it("triages the inbox through a single agent step (WP-B4)", () => {
    const wf = mailTriage.workflows[0]!
    expect(wf.steps.map((s) => `${s.id}:${s.kind}`)).toEqual(["triage:agent"])
    const refs = wf.steps.map((s) => (s as { agent?: { ref: string } }).agent?.ref)
    expect(refs).toEqual(["@agentproto/triager"])
  })
})
