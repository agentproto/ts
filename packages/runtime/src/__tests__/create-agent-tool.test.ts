/**
 * Unit tests for `create_agent` (`create-agent-tool.ts`): the pure manifest
 * writer shared by the MCP tool. Exercises validation errors, the
 * write-only-when-absent guard, `force`, and the canonical layout.
 */

import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
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
