/**
 * Unit tests for the spawn `agentId`/`agentPath` manifest resolution
 * (`spawn-agent-manifest.ts`): id→path, explicit path, missing manifest →
 * clear typed error, and unrelated/invalid input.
 */

import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveAgentManifestPath, loadAgentManifestDefaults } from "../spawn-agent-manifest.js"

const tmpRoots: string[] = []
async function mktmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "runtime-spawn-manifest-"))
  tmpRoots.push(dir)
  return dir
}
afterEach(async () => {
  for (const p of tmpRoots) await rm(p, { recursive: true, force: true })
  tmpRoots.length = 0
})

/** Write a minimal valid AGENT.md at `<root>/.agents/<id>/AGENT.md`. */
async function writeAgent(root: string, id: string, body = `You are ${id}.`): Promise<string> {
  const dir = join(root, ".agents", id)
  await mkdir(dir, { recursive: true })
  const path = join(dir, "AGENT.md")
  await writeFile(
    path,
    [
      "---",
      "schema: agent/v1",
      `id: ${id}`,
      `description: Agent ${id}`,
      "model: test-model",
      "skills: [search]",
      "tools: [read_file]",
      "---",
      "",
      body,
    ].join("\n") + "\n",
    "utf8",
  )
  return path
}

describe("resolveAgentManifestPath", () => {
  it("resolves agentId to <root>/.agents/<id>/AGENT.md", () => {
    const out = resolveAgentManifestPath({ agentId: "reviewer" }, "/ws")
    expect(out).toEqual({ ok: true, path: join("/ws", ".agents", "reviewer", "AGENT.md") })
  })

  it("strips the @owner/ prefix for an owner-prefixed agentId (create→resolve round-trip)", () => {
    const out = resolveAgentManifestPath({ agentId: "@acme/reviewer" }, "/ws")
    expect(out).toEqual({ ok: true, path: join("/ws", ".agents", "reviewer", "AGENT.md") })
  })

  it("resolves an absolute agentPath as-is", () => {
    const out = resolveAgentManifestPath({ agentPath: "/tmp/x/AGENT.md" }, "/ws")
    expect(out).toEqual({ ok: true, path: "/tmp/x/AGENT.md" })
  })

  it("resolves a relative agentPath against the root", () => {
    const out = resolveAgentManifestPath({ agentPath: "agents/x/AGENT.md" }, "/ws")
    expect(out).toEqual({ ok: true, path: join("/ws", "agents/x/AGENT.md") })
  })

  it("prefers agentPath over agentId when both are set", () => {
    const out = resolveAgentManifestPath({ agentId: "a", agentPath: "./b/AGENT.md" }, "/ws")
    expect(out).toEqual({ ok: true, path: join("/ws", "./b/AGENT.md") })
  })

  it("errors clearly when agentId has no root", () => {
    const out = resolveAgentManifestPath({ agentId: "a" }, undefined)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.code).toBe("agent_manifest_unresolved")
      expect(out.message).toContain("cwd")
    }
  })

  it("returns no_agent_ref when neither field is given", () => {
    const out = resolveAgentManifestPath({}, "/ws")
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.code).toBe("no_agent_ref")
  })
})

describe("loadAgentManifestDefaults", () => {
  it("loads a manifest and projects model/instructions/skills/tools", async () => {
    const root = await mktmp()
    await writeAgent(root, "reviewer", "You review rigorously.")
    const out = await loadAgentManifestDefaults(join(root, ".agents", "reviewer", "AGENT.md"), {
      adapter: "opencode",
      resolveAgentAdapter: (async () => ({ deliversSessionSkills: true }) as never) as never,
    })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.defaults.model).toBe("test-model")
      expect(out.defaults.instructions).toContain("You review rigorously.")
      expect(out.defaults.skills).toEqual(["search"])
      expect(out.defaults.tools).toEqual(["read_file"])
    }
  })

  it("projects an `options` map (AGENT.md path) for a manifest-native adapter", async () => {
    const root = await mktmp()
    const path = await writeAgent(root, "native")
    const out = await loadAgentManifestDefaults(path, {
      adapter: "mastra-agent",
      resolveAgentAdapter: (async () => ({ agentManifestOption: "agent" }) as never) as never,
    })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.defaults.options).toEqual({ agent: path })
      // A manifest-native adapter takes the path, not rendered instructions.
      expect(out.defaults.instructions).toBeUndefined()
      expect(out.defaults.systemPrompt).toBeUndefined()
    }
  })

  it("a caller model override wins over the manifest's model", async () => {
    const root = await mktmp()
    await writeAgent(root, "reviewer")
    const out = await loadAgentManifestDefaults(join(root, ".agents", "reviewer", "AGENT.md"), {
      adapter: "opencode",
      modelOverride: "caller-model",
    })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.defaults.model).toBe("caller-model")
  })

  it("returns a clear typed error for a missing manifest", async () => {
    const root = await mktmp()
    const out = await loadAgentManifestDefaults(join(root, ".agents", "ghost", "AGENT.md"), {
      adapter: "opencode",
    })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.code).toBe("agent_manifest_unreadable")
      expect(out.message).toContain("ghost")
    }
  })
})
