/**
 * Unit tests for `create_agent` (`create-agent-tool.ts`): the pure manifest
 * writer shared by the MCP tool. Exercises validation errors, the
 * write-only-when-absent guard, `force`, and the canonical layout.
 */

import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { existsSync } from "node:fs"
import { join } from "node:path"
import matter from "gray-matter"
import { createAgentManifest, DEFAULT_CREATED_AGENT_MODEL } from "../create-agent-tool.js"

const tmpRoots: string[] = []
async function mktmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "runtime-create-agent-"))
  tmpRoots.push(dir)
  return dir
}
afterEach(async () => {
  for (const p of tmpRoots) await rm(p, { recursive: true, force: true })
  tmpRoots.length = 0
})

describe("createAgentManifest", () => {
  it("writes a valid agent/v1 manifest under the canonical layout", async () => {
    const workspace = await mktmp()
    const created = await createAgentManifest({ workspace, id: "reviewer" })
    expect(created.id).toBe("reviewer")
    expect(created.path).toBe(join(workspace, ".agents", "reviewer", "AGENT.md"))
    const fm = matter(await readFile(created.path, "utf8")).data as Record<string, unknown>
    expect(fm.schema).toBe("agent/v1")
    expect(fm.id).toBe("reviewer")
    expect(fm.model).toBe(DEFAULT_CREATED_AGENT_MODEL)
  })

  it("strips an @owner/ prefix for the on-disk dir (matches spawn resolution)", async () => {
    const workspace = await mktmp()
    const created = await createAgentManifest({ workspace, id: "@acme/reviewer" })
    expect(created.id).toBe("reviewer")
    expect(created.path).toBe(join(workspace, ".agents", "reviewer", "AGENT.md"))
    const fm = matter(await readFile(created.path, "utf8")).data as Record<string, unknown>
    expect(fm.id).toBe("@acme/reviewer")
  })

  it("throws on an existing manifest without force", async () => {
    const workspace = await mktmp()
    await createAgentManifest({ workspace, id: "dup" })
    await expect(createAgentManifest({ workspace, id: "dup" })).rejects.toThrow(/already exists/)
  })

  it("overwrites with force", async () => {
    const workspace = await mktmp()
    await createAgentManifest({ workspace, id: "dup" })
    const created = await createAgentManifest({
      workspace,
      id: "dup",
      force: true,
      description: "Second.",
    })
    const fm = matter(await readFile(created.path, "utf8")).data as Record<string, unknown>
    expect(fm.description).toBe("Second.")
  })

  it("surfaces a validation error for an invalid slug", async () => {
    const workspace = await mktmp()
    await expect(createAgentManifest({ workspace, id: "Not A Slug" })).rejects.toThrow(/defineAgent/i)
  })

  it("refuses a directory that is a manifest dir with no AGENT.md conflict", async () => {
    // A dir without an AGENT.md is not an existing manifest — the write succeeds.
    const workspace = await mktmp()
    await mkdir(join(workspace, ".agents", "fresh"), { recursive: true })
    await writeFile(join(workspace, ".agents", "fresh", "other.txt"), "x", "utf8")
    const created = await createAgentManifest({ workspace, id: "fresh" })
    expect(created.path).toBe(join(workspace, ".agents", "fresh", "AGENT.md"))
  })
})

describe("createAgentManifest grants (actions.granted)", () => {
  async function writeCaller(workspace: string, id: string, granted: string[]): Promise<void> {
    await mkdir(join(workspace, ".agents", id), { recursive: true })
    const actions = granted.length > 0 ? `actions:\n  granted:\n${granted.map(g => `    - ${g}`).join("\n")}\n` : ""
    await writeFile(
      join(workspace, ".agents", id, "AGENT.md"),
      `---\nschema: agent/v1\nid: ${id}\ndescription: caller\nmodel: claude-sonnet-5\n${actions}---\n`,
      "utf8",
    )
  }

  it("grants nothing by default", async () => {
    const workspace = await mktmp()
    const created = await createAgentManifest({ workspace, id: "plain" })
    const fm = matter(await readFile(created.path, "utf8")).data as Record<string, unknown>
    expect(fm.actions).toBeUndefined()
  })

  it("writes actions.granted: [create_tool] when asked, by a caller that holds that grant", async () => {
    const workspace = await mktmp()
    await writeCaller(workspace, "builder", ["create_tool"])
    const created = await createAgentManifest({
      workspace,
      id: "toolsmith",
      grants: ["create_tool"],
      callerAgentId: "builder",
    })
    const fm = matter(await readFile(created.path, "utf8")).data as { actions?: { granted?: unknown[] } }
    expect(fm.actions?.granted).toEqual(["create_tool"])
  })

  it("refuses to hand out a grant the caller does not hold (no escalation)", async () => {
    const workspace = await mktmp()
    await writeCaller(workspace, "mallory", [])
    await expect(
      createAgentManifest({ workspace, id: "toolsmith", grants: ["create_tool"], callerAgentId: "mallory" }),
    ).rejects.toThrow(/does not grant 'create_tool'/)
    expect(existsSync(join(workspace, ".agents", "toolsmith", "AGENT.md"))).toBe(false)
  })

  it("refuses a grant when the call carries no caller identity", async () => {
    const workspace = await mktmp()
    await expect(
      createAgentManifest({ workspace, id: "toolsmith", grants: ["create_tool"] }),
    ).rejects.toThrow(/no authenticated caller identity/)
  })
})
