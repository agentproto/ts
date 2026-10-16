/**
 * `create_tool` / `delete_tool` (Block 3.2–3.3) — the AIP-14/AIP-30 authoring
 * verb, gated by the caller's AIP-42 `actions.granted` (default DENY) and
 * bounded by a minimum lifetime + a per-agent/day delete limit.
 */

import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parseToolManifest } from "@agentproto/tool"
import { parseDriverManifest } from "@agentproto/driver/manifest"
import {
  DEFAULT_MIN_LIFETIME_MS,
  createToolManifest,
  deleteToolManifest,
} from "../create-tool-tool.js"

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "create-tool-"))
})
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

async function writeAgent(id: string, granted?: string[]): Promise<void> {
  const dir = join(workspace, ".agents", id)
  await mkdir(dir, { recursive: true })
  const actions = granted
    ? granted.length > 0
      ? `actions:\n  granted:\n${granted.map(g => `    - ${g}`).join("\n")}\n`
      : `actions:\n  granted: []\n`
    : ""
  await writeFile(
    join(dir, "AGENT.md"),
    `---\nschema: agent/v1\nid: ${id}\ndescription: test agent\nmodel: claude-sonnet-5\n${actions}---\n\nBody.\n`,
    "utf8",
  )
}

const cliDriver = { kind: "cli" as const, bin: "node", argv: ["scripts/x.mjs"] }

describe("createToolManifest", () => {
  it("denies by default when the agent grants nothing", async () => {
    await writeAgent("builder", [])
    await expect(
      createToolManifest({ workspace, id: "my.tool", description: "d", agentId: "builder", driver: cliDriver }),
    ).rejects.toThrow(/does not grant 'create_tool'/)
    expect(existsSync(join(workspace, ".agentproto", "tools", "my.tool", "TOOL.md"))).toBe(false)
  })

  it("denies when the agent manifest does not exist", async () => {
    await expect(
      createToolManifest({ workspace, id: "my.tool", description: "d", agentId: "ghost", driver: cliDriver }),
    ).rejects.toThrow(/no AGENT.md found/)
  })

  it("writes a valid TOOL.md + DRIVER.md pair when granted", async () => {
    await writeAgent("builder", ["create_tool"])
    const created = await createToolManifest({
      workspace,
      id: "my.tool",
      description: "Does a thing.",
      agentId: "builder",
      driver: cliDriver,
      inputs: { type: "object", properties: { x: { type: "string" } } },
    })
    expect(created.toolPath).toBe(join(workspace, ".agentproto", "tools", "my.tool", "TOOL.md"))
    const tool = parseToolManifest(await readFile(created.toolPath, "utf8"))
    expect(tool.frontmatter.id).toBe("my.tool")
    expect(tool.frontmatter.approval).toBe("always")
    const driver = parseDriverManifest(await readFile(created.driverPath, "utf8"))
    expect(driver.frontmatter.kind).toBe("cli")
    expect(driver.frontmatter.implements[0]?.tool).toBe("my.tool")
  })

  it("also accepts the structured { action } grant form", async () => {
    const dir = join(workspace, ".agents", "builder")
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, "AGENT.md"),
      `---\nschema: agent/v1\nid: builder\ndescription: t\nmodel: m\nactions:\n  granted:\n    - action: create_tool\n---\n`,
      "utf8",
    )
    await expect(
      createToolManifest({ workspace, id: "my.tool", description: "d", agentId: "builder", driver: cliDriver }),
    ).resolves.toBeDefined()
  })

  it("rejects an id that fails the AIP-14 pattern", async () => {
    await writeAgent("builder", ["create_tool"])
    await expect(
      createToolManifest({ workspace, id: "Bad Id", description: "d", agentId: "builder", driver: cliDriver }),
    ).rejects.toThrow(/invalid id/)
  })

  it("refuses to overwrite an existing tool before its minimum lifetime", async () => {
    await writeAgent("builder", ["create_tool"])
    const first = await createToolManifest({
      workspace,
      id: "my.tool",
      description: "d",
      agentId: "builder",
      driver: cliDriver,
    })
    // Overwrite inside minLifetime → refused even with force.
    await expect(
      createToolManifest({ workspace, id: "my.tool", description: "d2", agentId: "builder", driver: cliDriver, force: true }),
    ).rejects.toThrow(/minimum lifetime/)
    // Age the file past minLifetime → force now succeeds.
    const old = new Date(Date.now() - DEFAULT_MIN_LIFETIME_MS - 60_000)
    await utimes(first.toolPath, old, old)
    await expect(
      createToolManifest({ workspace, id: "my.tool", description: "d2", agentId: "builder", driver: cliDriver, force: true }),
    ).resolves.toBeDefined()
  })

  it("refuses overwrite without force even when old enough", async () => {
    await writeAgent("builder", ["create_tool"])
    const first = await createToolManifest({
      workspace,
      id: "my.tool",
      description: "d",
      agentId: "builder",
      driver: cliDriver,
      minLifetimeMs: 0,
    })
    const old = new Date(Date.now() - 10_000)
    await utimes(first.toolPath, old, old)
    await expect(
      createToolManifest({ workspace, id: "my.tool", description: "d2", agentId: "builder", driver: cliDriver }),
    ).rejects.toThrow(/already exists/)
  })
})

describe("deleteToolManifest", () => {
  it("deletes a tool that is past its minimum lifetime and records a tombstone", async () => {
    await writeAgent("builder", ["create_tool"])
    const created = await createToolManifest({
      workspace,
      id: "my.tool",
      description: "d",
      agentId: "builder",
      driver: cliDriver,
      minLifetimeMs: 0,
    })
    const result = await deleteToolManifest({ workspace, id: "my.tool", agentId: "builder", minLifetimeMs: 0 })
    expect(result.deleted).toContain(created.toolPath)
    expect(existsSync(created.toolPath)).toBe(false)
    expect(existsSync(join(workspace, ".agentproto", "tools", ".tombstones.json"))).toBe(true)
  })

  it("refuses to delete inside the minimum lifetime", async () => {
    await writeAgent("builder", ["create_tool"])
    await createToolManifest({ workspace, id: "my.tool", description: "d", agentId: "builder", driver: cliDriver })
    await expect(deleteToolManifest({ workspace, id: "my.tool", agentId: "builder" })).rejects.toThrow(
      /minimum lifetime/,
    )
  })

  it("stops thrash at the per-agent/day delete-limit", async () => {
    await writeAgent("builder", ["create_tool"])
    for (let i = 0; i < 2; i++) {
      await createToolManifest({
        workspace,
        id: `my.tool${i}`,
        description: "d",
        agentId: "builder",
        driver: cliDriver,
        minLifetimeMs: 0,
      })
      await deleteToolManifest({ workspace, id: `my.tool${i}`, agentId: "builder", minLifetimeMs: 0, deleteLimit: 2 })
    }
    await createToolManifest({
      workspace,
      id: "my.tool9",
      description: "d",
      agentId: "builder",
      driver: cliDriver,
      minLifetimeMs: 0,
    })
    await expect(
      deleteToolManifest({ workspace, id: "my.tool9", agentId: "builder", minLifetimeMs: 0, deleteLimit: 2 }),
    ).rejects.toThrow(/deletion\/day limit/)
  })

  it("denies delete to an agent without the grant", async () => {
    await writeAgent("builder", ["create_tool"])
    await createToolManifest({
      workspace,
      id: "my.tool",
      description: "d",
      agentId: "builder",
      driver: cliDriver,
      minLifetimeMs: 0,
    })
    await writeAgent("nobody", [])
    await expect(
      deleteToolManifest({ workspace, id: "my.tool", agentId: "nobody", minLifetimeMs: 0 }),
    ).rejects.toThrow(/does not grant 'create_tool'/)
  })
})
