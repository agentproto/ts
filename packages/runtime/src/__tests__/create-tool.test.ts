/**
 * `create_tool` / `delete_tool` (Block 3.2–3.3) — the AIP-14/AIP-30 authoring
 * verb, gated by the CALLER'S own AIP-42 `actions.granted` (default DENY,
 * resolved from the daemon-trusted caller identity) and bounded by a minimum
 * lifetime + authoring marker + a per-agent/day delete limit + a reclaimable
 * authoring lock.
 */

import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { parseToolManifest } from "@agentproto/tool"
import { parseDriverManifest } from "@agentproto/driver/manifest"
import {
  AUTHORING_LOCK_TTL_MS,
  DEFAULT_MIN_LIFETIME_MS,
  createToolManifest,
  deleteToolManifest,
  registerCreateToolTools,
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
const builder = { callerAgentId: "builder" }
const toolFileOf = (id: string) => join(workspace, ".agentproto", "tools", id, "TOOL.md")
const markerOf = (id: string) => join(workspace, ".agentproto", "tools", id, ".authoring.json")
const lockFile = () => join(workspace, ".agentproto", "tools", ".authoring.lock")

describe("createToolManifest", () => {
  it("denies by default when the agent grants nothing", async () => {
    await writeAgent("builder", [])
    await expect(
      createToolManifest({ workspace, id: "my.tool", description: "d", ...builder, driver: cliDriver }),
    ).rejects.toThrow(/does not grant 'create_tool'/)
    expect(existsSync(toolFileOf("my.tool"))).toBe(false)
  })

  it("denies when the caller manifest does not exist", async () => {
    await expect(
      createToolManifest({ workspace, id: "my.tool", description: "d", callerAgentId: "ghost", driver: cliDriver }),
    ).rejects.toThrow(/no AGENT.md found/)
  })

  it("FAILS CLOSED when the call carries no caller identity", async () => {
    await writeAgent("builder", ["create_tool"])
    await expect(
      createToolManifest({ workspace, id: "my.tool", description: "d", callerSessionId: "sess_x", driver: cliDriver }),
    ).rejects.toThrow(/no authenticated caller identity.*sess_x/s)
    expect(existsSync(toolFileOf("my.tool"))).toBe(false)
  })

  it("rejects a caller id that could traverse the filesystem", async () => {
    await expect(
      createToolManifest({
        workspace,
        id: "my.tool",
        description: "d",
        callerAgentId: "../../etc",
        driver: cliDriver,
      }),
    ).rejects.toThrow(/invalid caller agent id/)
    expect(existsSync(toolFileOf("my.tool"))).toBe(false)
  })

  it("binds the grant to the caller, not to a spoofed agentId in the payload", async () => {
    await writeAgent("builder", ["create_tool"])
    await writeAgent("mallory", [])
    // A caller-supplied `agentId` in the input is NOT a grant subject: only
    // the trusted caller* fields count. Mallory names builder and is denied.
    const spoofed = {
      workspace,
      id: "my.tool",
      description: "d",
      callerAgentId: "mallory",
      agentId: "builder",
      driver: cliDriver,
    } as unknown as Parameters<typeof createToolManifest>[0]
    await expect(createToolManifest(spoofed)).rejects.toThrow(/does not grant 'create_tool'/)
    expect(existsSync(toolFileOf("my.tool"))).toBe(false)
  })

  it("writes a valid TOOL.md + DRIVER.md pair and an authoring marker when granted", async () => {
    await writeAgent("builder", ["create_tool"])
    const created = await createToolManifest({
      workspace,
      id: "my.tool",
      description: "Does a thing.",
      ...builder,
      driver: cliDriver,
      inputs: { type: "object", properties: { x: { type: "string" } } },
    })
    expect(created.toolPath).toBe(toolFileOf("my.tool"))
    const tool = parseToolManifest(await readFile(created.toolPath, "utf8"))
    expect(tool.frontmatter.id).toBe("my.tool")
    expect(tool.frontmatter.approval).toBe("always")
    const driver = parseDriverManifest(await readFile(created.driverPath, "utf8"))
    expect(driver.frontmatter.kind).toBe("cli")
    expect(driver.frontmatter.implements[0]?.tool).toBe("my.tool")
    const marker = JSON.parse(await readFile(markerOf("my.tool"), "utf8")) as {
      creatorAgent: string
      by: string
    }
    expect(marker).toMatchObject({ creatorAgent: "builder", by: "create_tool" })
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
      createToolManifest({ workspace, id: "my.tool", description: "d", ...builder, driver: cliDriver }),
    ).resolves.toBeDefined()
  })

  it("rejects an id that fails the AIP-14 pattern", async () => {
    await writeAgent("builder", ["create_tool"])
    await expect(
      createToolManifest({ workspace, id: "Bad Id", description: "d", ...builder, driver: cliDriver }),
    ).rejects.toThrow(/invalid id/)
  })

  it("refuses an operator-authored TOOL.md even with force:true (no marker)", async () => {
    await writeAgent("builder", ["create_tool"])
    const opTool = toolFileOf("manual")
    await mkdir(join(workspace, ".agentproto", "tools", "manual"), { recursive: true })
    await writeFile(opTool, "---\nschema: agentproto/tool/v1\nid: manual\n---\n", "utf8")
    // Older than the min lifetime — only the marker guard can refuse it.
    const old = new Date(Date.now() - DEFAULT_MIN_LIFETIME_MS - 60_000)
    await utimes(opTool, old, old)
    await expect(
      createToolManifest({ workspace, id: "manual", description: "d", ...builder, driver: cliDriver, force: true }),
    ).rejects.toThrow(/not authored by create_tool/)
    expect(await readFile(opTool, "utf8")).toContain("id: manual")
  })

  it("refuses to overwrite an existing authored tool before its minimum lifetime", async () => {
    await writeAgent("builder", ["create_tool"])
    const first = await createToolManifest({
      workspace,
      id: "my.tool",
      description: "d",
      ...builder,
      driver: cliDriver,
    })
    // Overwrite inside minLifetime → refused even with force.
    await expect(
      createToolManifest({ workspace, id: "my.tool", description: "d2", ...builder, driver: cliDriver, force: true }),
    ).rejects.toThrow(/minimum lifetime/)
    // Age the file past minLifetime → force now succeeds (marker present).
    const old = new Date(Date.now() - DEFAULT_MIN_LIFETIME_MS - 60_000)
    await utimes(first.toolPath, old, old)
    await expect(
      createToolManifest({ workspace, id: "my.tool", description: "d2", ...builder, driver: cliDriver, force: true }),
    ).resolves.toBeDefined()
  })

  it("refuses overwrite without force even when old enough", async () => {
    await writeAgent("builder", ["create_tool"])
    const first = await createToolManifest({
      workspace,
      id: "my.tool",
      description: "d",
      ...builder,
      driver: cliDriver,
      minLifetimeMs: 0,
    })
    const old = new Date(Date.now() - 10_000)
    await utimes(first.toolPath, old, old)
    await expect(
      createToolManifest({ workspace, id: "my.tool", description: "d2", ...builder, driver: cliDriver }),
    ).rejects.toThrow(/already exists/)
  })

  it("reclaims a stale (past-TTL) authoring lock instead of DoSing forever", async () => {
    await writeAgent("builder", ["create_tool"])
    const lock = lockFile()
    await mkdir(join(workspace, ".agentproto", "tools"), { recursive: true })
    await writeFile(
      lock,
      JSON.stringify({ pid: process.pid, at: new Date(Date.now() - AUTHORING_LOCK_TTL_MS - 60_000).toISOString() }),
      "utf8",
    )
    await expect(
      createToolManifest({ workspace, id: "my.tool", description: "d", ...builder, driver: cliDriver }),
    ).resolves.toBeDefined()
    expect(existsSync(lock)).toBe(false) // released after the call
  })

  it("refuses a fresh, live authoring lock", async () => {
    await writeAgent("builder", ["create_tool"])
    const lock = lockFile()
    await mkdir(join(workspace, ".agentproto", "tools"), { recursive: true })
    await writeFile(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8")
    await expect(
      createToolManifest({ workspace, id: "my.tool", description: "d", ...builder, driver: cliDriver }),
    ).rejects.toThrow(/another tool-authoring call is in progress/)
  })
})

describe("deleteToolManifest", () => {
  it("deletes an authored tool past its minimum lifetime and records a tombstone", async () => {
    await writeAgent("builder", ["create_tool"])
    const created = await createToolManifest({
      workspace,
      id: "my.tool",
      description: "d",
      ...builder,
      driver: cliDriver,
      minLifetimeMs: 0,
    })
    const result = await deleteToolManifest({ workspace, id: "my.tool", ...builder, minLifetimeMs: 0 })
    expect(result.deleted).toContain(created.toolPath)
    expect(existsSync(created.toolPath)).toBe(false)
    expect(existsSync(join(workspace, ".agentproto", "tools", ".tombstones.json"))).toBe(true)
  })

  it("refuses to delete a tool this mechanism did not author", async () => {
    await writeAgent("builder", ["create_tool"])
    const opTool = toolFileOf("manual")
    await mkdir(join(workspace, ".agentproto", "tools", "manual"), { recursive: true })
    await writeFile(opTool, "---\nschema: agentproto/tool/v1\nid: manual\n---\n", "utf8")
    await expect(
      deleteToolManifest({ workspace, id: "manual", ...builder, minLifetimeMs: 0 }),
    ).rejects.toThrow(/not authored by create_tool/)
    expect(existsSync(opTool)).toBe(true)
  })

  it("refuses to delete inside the minimum lifetime", async () => {
    await writeAgent("builder", ["create_tool"])
    await createToolManifest({ workspace, id: "my.tool", description: "d", ...builder, driver: cliDriver })
    await expect(deleteToolManifest({ workspace, id: "my.tool", ...builder })).rejects.toThrow(/minimum lifetime/)
  })

  it("stops thrash at the per-agent/day delete-limit", async () => {
    await writeAgent("builder", ["create_tool"])
    for (let i = 0; i < 2; i++) {
      await createToolManifest({
        workspace,
        id: `my.tool${i}`,
        description: "d",
        ...builder,
        driver: cliDriver,
        minLifetimeMs: 0,
      })
      await deleteToolManifest({ workspace, id: `my.tool${i}`, ...builder, minLifetimeMs: 0, deleteLimit: 2 })
    }
    await createToolManifest({
      workspace,
      id: "my.tool9",
      description: "d",
      ...builder,
      driver: cliDriver,
      minLifetimeMs: 0,
    })
    await expect(
      deleteToolManifest({ workspace, id: "my.tool9", ...builder, minLifetimeMs: 0, deleteLimit: 2 }),
    ).rejects.toThrow(/deletion\/day limit/)
  })

  it("denies delete to an unauthed caller", async () => {
    await writeAgent("builder", ["create_tool"])
    await createToolManifest({
      workspace,
      id: "my.tool",
      description: "d",
      ...builder,
      driver: cliDriver,
      minLifetimeMs: 0,
    })
    await writeAgent("nobody", [])
    await expect(
      deleteToolManifest({ workspace, id: "my.tool", callerAgentId: "nobody", minLifetimeMs: 0 }),
    ).rejects.toThrow(/does not grant 'create_tool'/)
  })
})

describe("registerCreateToolTools (MCP surface)", () => {
  async function buildClient(opts: Parameters<typeof registerCreateToolTools>[1]): Promise<Client> {
    const server = new McpServer({ name: "create-tool-test", version: "0.0.0" })
    registerCreateToolTools(server, opts)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "create-tool-client", version: "0.0.0" })
    await client.connect(clientTransport)
    return client
  }

  async function call(client: Client, name: string, args: Record<string, unknown>) {
    try {
      const result = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ text?: string }>
        isError?: boolean
      }
      return { isError: result.isError === true, text: result.content[0]?.text ?? "" }
    } catch (err) {
      return { isError: true, text: err instanceof Error ? err.message : String(err) }
    }
  }

  it("ignores a spoofed agentId in the payload (grant is bound to the session)", async () => {
    await writeAgent("builder", ["create_tool"])
    await writeAgent("mallory", [])
    const client = await buildClient({ workspace, agentId: "mallory", sessionId: "sess_mallory" })
    const res = await call(client, "create_tool", {
      id: "my.tool",
      description: "d",
      agentId: "builder",
      driver: cliDriver,
    })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/does not grant 'create_tool'/)
    expect(existsSync(toolFileOf("my.tool"))).toBe(false)
  })

  it("fails closed with the session named when no caller identity is wired", async () => {
    await writeAgent("builder", ["create_tool"])
    const client = await buildClient({ workspace, sessionId: "sess_anon" })
    const res = await call(client, "create_tool", { id: "my.tool", description: "d", driver: cliDriver })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/no authenticated caller identity.*sess_anon/s)
  })

  it("authorizes when the wired caller manifest grants create_tool", async () => {
    await writeAgent("builder", ["create_tool"])
    const client = await buildClient({ workspace, agentId: "builder", sessionId: "sess_builder" })
    const res = await call(client, "create_tool", { id: "my.tool", description: "d", driver: cliDriver })
    expect(res.isError).toBe(false)
    expect(existsSync(toolFileOf("my.tool"))).toBe(true)
  })
})
