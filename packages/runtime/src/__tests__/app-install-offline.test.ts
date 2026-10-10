/**
 * `agentproto app install <dir>` with no daemon must write the SAME registry
 * record the daemon's `app_install {dir}` writes (it runs the same
 * `performInstall`), not a bare `{appId, dir, dataDir}`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { defineApp } from "@agentproto/app-kit"
import { defineAgent } from "@agentproto/agent"
import { defineWorkflow } from "@agentproto/workflow"
import { registerAppTools } from "../app-tools.js"
import { createAppRegistry } from "../app-registry.js"
import { createSessionsRegistry } from "../sessions.js"
import { installAppDirOffline } from "../app-install-offline.js"

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "app-install-offline-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function emitFixture(dir: string): Promise<void> {
  await defineApp({
    id: "@test/fixture-app",
    name: "Fixture App",
    version: "1.2.3",
    agents: [
      {
        agent: defineAgent({
          schema: "agent/v1",
          id: "worker",
          description: "A worker agent.",
          model: "claude-sonnet-5",
          workflows: [{ ref: "do-thing" }],
        }),
        body: "You do the thing.",
      },
    ],
    workflows: [
      defineWorkflow({
        id: "do-thing",
        name: "Do thing",
        description: "Does a thing.",
        version: "0.1.0",
        inputs: {},
        outputs: {},
        steps: [{ id: "step1", kind: "tool", tool: "known_tool" }],
      }),
    ],
  }).emit(dir)
}

type Rec = Record<string, unknown>
async function readRecord(persistPath: string): Promise<Rec> {
  const file = JSON.parse(await readFile(persistPath, "utf8")) as { apps: Rec[] }
  expect(file.apps).toHaveLength(1)
  return file.apps[0]!
}
const stable = (r: Rec): Rec => {
  const { installedAt: _i, updatedAt: _u, stateDir: _s, ...rest } = r
  return rest
}

describe("offline CLI install vs MCP app_install", () => {
  it("writes an identical full record", async () => {
    const appDir = join(root, "app")
    await emitFixture(appDir)

    const mcpPath = join(root, "mcp", "apps.json")
    const mcpServer = new McpServer({ name: "t", version: "0" })
    registerAppTools(mcpServer, {
      registry: createSessionsRegistry({ persist: false }),
      listRegisteredToolIds: async () => ["known_tool"],
      appRegistry: createAppRegistry({ persistPath: mcpPath }),
      resolveAgentAdapter: async slug =>
        slug === "mastra-agent" ? ({ startSession: async () => ({}), commandPreview: "x" } as never) : null,
    })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await mcpServer.connect(st)
    const client = new Client({ name: "c", version: "0" })
    await client.connect(ct)
    const res = await client.callTool({ name: "app_install", arguments: { dir: appDir } })
    expect((res as { isError?: boolean }).isError).not.toBe(true)

    const cliPath = join(root, "cli", "apps.json")
    const out = await installAppDirOffline(appDir, { persistPath: cliPath })
    expect(out.ok).toBe(true)

    const mcpRec = await readRecord(mcpPath)
    const cliRec = await readRecord(cliPath)
    expect(Array.isArray(cliRec["workflows"])).toBe(true)
    expect((cliRec["workflows"] as unknown[]).length).toBe(1)
    expect((cliRec["agents"] as unknown[]).length).toBe(1)
    expect(stable(cliRec)).toEqual(stable(mcpRec))
    // The record a restarted daemon loads is clean.
    expect(createAppRegistry({ persistPath: cliPath }).listIssues()).toEqual([])
  })

  it("honors an explicit dataDir and reports an invalid app instead of writing a record", async () => {
    const appDir = join(root, "app")
    await emitFixture(appDir)
    const p = join(root, "apps.json")
    const ok = await installAppDirOffline(appDir, { persistPath: p, dataDir: join(root, "out") })
    expect(ok.ok && ok.record.dataDir).toBe(join(root, "out"))

    const bad = await installAppDirOffline(join(root, "not-an-app"), { persistPath: join(root, "bad.json") })
    expect(bad.ok).toBe(false)
    await expect(readFile(join(root, "bad.json"), "utf8")).rejects.toThrow()
  })
})
