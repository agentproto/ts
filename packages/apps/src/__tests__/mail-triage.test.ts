import { describe, it, expect, afterAll } from "vitest"
import { loadAppHandle } from "@agentproto/app-kit"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mailTriage } from "../mail-triage/index.js"

const fakeModel = { provider: "test", id: "test-model" }

describe("mail-triage app", () => {
  it("exposes stable app identity fields", () => {
    expect(mailTriage.id).toBe("@agentproto/mail-triage")
    expect(mailTriage.name).toBe("Mail Triage")
    expect(mailTriage.version).toBe("0.1.0")
  })

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
    expect(built["@agentproto/triager"]!.instructions).toContain("triage plan")
  })

  it("gives the triager the mailbox tools it needs to act", () => {
    const triager = mailTriage.agents[0]!.agent
    expect(triager.tools).toEqual([
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

  it("triages the inbox through a single agent step (WP mail-triage)", () => {
    const wf = mailTriage.workflows[0]!
    expect(wf.steps.map((s) => `${s.id}:${s.kind}`)).toEqual(["triage:agent"])
    const refs = wf.steps.map((s) => (s as { agent?: { ref: string } }).agent?.ref)
    expect(refs).toEqual(["@agentproto/triager"])
  })

  it("round-trips emit → loadAppHandle preserving identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mail-triage-roundtrip-"))
    try {
      await mailTriage.emit(dir)
      const loaded = await loadAppHandle(dir)
      expect(loaded.id).toBe(mailTriage.id)
      expect(loaded.name).toBe(mailTriage.name)
      expect(loaded.version).toBe(mailTriage.version)
      expect(loaded.agents.map((a) => a.agent.id)).toEqual(
        mailTriage.agents.map((a) => a.agent.id),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
