import { describe, it, expect } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentVerbs, defineAgent } from "@agentproto/agent"
import { emitApp, renderAgentManifest } from "../emit.js"

const def = {
  schema: "agent/v1" as const,
  id: "synthetic",
  description: "A synthetic agent.",
  model: "provider/model",
  boundaries: ["never A"],
  tags: ["synthetic"],
}
const body = "You are synthetic.\n\nSecond paragraph."

describe("one AGENT.md renderer", () => {
  let dir: string
  const setup = async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-render-parity-"))
  }

  it("emitApp, renderAgentManifest and agentVerbs.create produce identical bytes", async () => {
    await setup()
    try {
      const emitted = await emitApp(
        { agents: [{ agent: defineAgent(def), body }], workflows: [] },
        dir,
      )
      const fromEmit = await readFile(emitted.agentPaths.synthetic!, "utf8")
      const fromRender = renderAgentManifest(def, body, { dir }).contents
      const fromVerbs = (await agentVerbs.create(def, { dir: "/unused", body, dryRun: true })).rendered
      expect(fromRender).toBe(fromEmit)
      expect(fromVerbs).toBe(fromEmit)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("agentVerbs.create without a body renders an empty body, not a heading stub", async () => {
    const rendered = (await agentVerbs.create(def, { dir: "/unused", dryRun: true })).rendered
    expect(rendered).toBe(renderAgentManifest(def, "", { dir: "/unused" }).contents)
    expect(rendered.endsWith("---\n\n\n")).toBe(true)
    expect(rendered).not.toMatch(/^# /m)
  })
})
