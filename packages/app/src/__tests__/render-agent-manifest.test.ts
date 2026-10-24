import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineAgent } from "@agentproto/agent"
import { loadAgent } from "@agentproto/agent"
import { renderAgentManifest } from "../emit.js"

const handle = defineAgent({
  schema: "agent/v1",
  id: "@acme/reviewer",
  description: "Reviews diffs.",
  model: "claude-sonnet-5",
})

describe("renderAgentManifest", () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-kit-render-agent-"))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("resolves the canonical `.agents/<id>/AGENT.md` path (owner prefix stripped)", () => {
    const rendered = renderAgentManifest(handle, "You review.", { dir })
    expect(rendered.id).toBe("reviewer")
    expect(rendered.path).toBe(join(dir, ".agents", "reviewer", "AGENT.md"))
    expect(rendered.contents).toContain("schema: agent/v1")
    expect(rendered.contents).toContain("@acme/reviewer")
    expect(rendered.contents).toContain("You review.")
  })

  it("resolves the app layout `.agentproto/agents/<id>/AGENT.md`", () => {
    const rendered = renderAgentManifest(handle, "", { dir, layout: "app" })
    expect(rendered.path).toBe(join(dir, ".agentproto", "agents", "reviewer", "AGENT.md"))
  })

  it("throws on an invalid handle (defineAgent validation)", () => {
    expect(() =>
      renderAgentManifest({ schema: "agent/v1", id: "BAD ID", description: "", model: "" } as never, "", {
        dir,
      }),
    ).toThrow(/defineAgent/i)
  })
})
