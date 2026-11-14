import { describe, it, expect } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentVerbs } from "../spec.js"
import { defineAgent } from "../define-agent.js"
import { renderAgentMd } from "../render.js"
import { parseAgentManifest } from "../manifest/index.js"

const def = {
  schema: "agent/v1" as const,
  id: "synthetic",
  description: "A synthetic agent.",
  model: "provider/model",
  boundaries: ["never A"],
}

describe("renderAgentMd", () => {
  it("round-trips through the strict parser", () => {
    const text = renderAgentMd({ agent: defineAgent(def), body: "You are synthetic." })
    const parsed = parseAgentManifest(text)
    expect(parsed.frontmatter.id).toBe("synthetic")
    expect(parsed.body.trim()).toBe("You are synthetic.")
  })

  it("agentVerbs.create renders the same bytes as renderAgentMd", async () => {
    const r = await agentVerbs.create(def, { dir: "/unused", body: "You are synthetic.", dryRun: true })
    expect(r.rendered).toBe(renderAgentMd({ agent: defineAgent(def), body: "You are synthetic." }))
  })

  it("an update with no change leaves the file bytes unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-render-"))
    try {
      const created = await agentVerbs.create(def, { dir, body: "You are synthetic." })
      await agentVerbs.update(created.path, (p) => p)
      const first = await readFile(created.path, "utf8")
      await agentVerbs.update(created.path, (p) => p)
      const second = await readFile(created.path, "utf8")
      expect(second).toBe(first)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
