/**
 * App data ownership (D1): a session that carries an app boundary may only
 * address that app's data, and an app UI may only point the `app_data_*` /
 * `app_state_*` tools at its own app. Host calls (no session, no UI) are
 * unchanged.
 */

import { HOST_CALLER } from "../caller-scope.js"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { registerAppDataTools } from "../app-data.js"
import { createAppRegistry } from "../app-registry.js"
import { performAppToolCall } from "../app-tools.js"

function errorText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return text
}
function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true
}

const TOOLS = ["app_data_write", "app_data_read", "app_data_list"] as const

async function registerPair(dirA: string, dirB: string, ownAppId?: string) {
  const appRegistry = createAppRegistry()
  appRegistry.upsertApp({
    appId: "@x/a",
    dir: dirA,
    agents: [],
    workflows: [],
    unvalidatedAgentTools: [],
    ui: { path: join(dirA, "index.html"), tools: [...TOOLS] },
  })
  appRegistry.upsertApp({
    appId: "@x/b",
    dir: dirB,
    agents: [],
    workflows: [],
    unvalidatedAgentTools: [],
  })
  const server = new McpServer({ name: "app-data-ownership-server", version: "0.0.0" })
  registerAppDataTools(server, { appRegistry, callerScope: HOST_CALLER, ownAppId } as never)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "app-data-ownership-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return { client, appRegistry }
}

let dirA: string
let dirB: string
beforeEach(async () => {
  dirA = await mkdtemp(join(tmpdir(), "app-data-own-a-"))
  dirB = await mkdtemp(join(tmpdir(), "app-data-own-b-"))
})
afterEach(async () => {
  await rm(dirA, { recursive: true, force: true })
  await rm(dirB, { recursive: true, force: true })
})

describe("a session carrying an app boundary", () => {
  it("a session of app A cannot write app B's data", async () => {
    const { client } = await registerPair(dirA, dirB, "@x/a")
    const result = await client.callTool({
      name: "app_data_write",
      arguments: { appId: "@x/b", path: "x.json", content: { a: 1 } },
    })
    expect(isError(result)).toBe(true)
    const text = errorText(result)
    expect(text).toMatch(/refused/)
    expect(text).toMatch(/only address its own app data/)
    expect(existsSync(join(dirB, "data", "x.json"))).toBe(false)
  })

  it("a session of app A cannot read or list app B's data", async () => {
    const { client } = await registerPair(dirA, dirB, "@x/a")
    const read = await client.callTool({
      name: "app_data_read",
      arguments: { appId: "@x/b", path: "x.json" },
    })
    expect(isError(read)).toBe(true)
    const list = await client.callTool({
      name: "app_data_list",
      arguments: { appId: "@x/b" },
    })
    expect(isError(list)).toBe(true)
  })

  it("a session of app A still writes its own data", async () => {
    const { client } = await registerPair(dirA, dirB, "@x/a")
    const result = await client.callTool({
      name: "app_data_write",
      arguments: { appId: "@x/a", path: "x.json", content: { a: 1 } },
    })
    expect(isError(result)).toBe(false)
    expect(existsSync(join(dirA, "data", "x.json"))).toBe(true)
  })

  it("a host call without ownAppId is unchanged", async () => {
    const { client } = await registerPair(dirA, dirB)
    const result = await client.callTool({
      name: "app_data_write",
      arguments: { appId: "@x/b", path: "x.json", content: { a: 1 } },
    })
    expect(isError(result)).toBe(false)
    expect(existsSync(join(dirB, "data", "x.json"))).toBe(true)
  })
})

describe("an app UI", () => {
  async function uiPair() {
    const { appRegistry } = await registerPair(dirA, dirB)
    const dispatchTool = vi.fn(async (name: string, args: Record<string, unknown>) => ({ name, args }))
    return { appRegistry, dispatchTool }
  }

  it("an app UI cannot point app_data_write at another app", async () => {
    const { appRegistry, dispatchTool } = await uiPair()
    const result = await performAppToolCall(
      appRegistry,
      { appId: "@x/a", tool: "app_data_write", args: { appId: "@x/b", path: "x.json", content: {} } },
      { dispatchTool },
    )
    expect(isError(result)).toBe(true)
    expect(errorText(result)).toMatch(/may only address its own data/)
    expect(dispatchTool).not.toHaveBeenCalled()
  })

  it("an app UI still reaches its own data", async () => {
    const { appRegistry, dispatchTool } = await uiPair()
    const args = { appId: "@x/a", path: "x.json", content: {} }
    await performAppToolCall(
      appRegistry,
      { appId: "@x/a", tool: "app_data_write", args },
      { dispatchTool },
    )
    expect(dispatchTool).toHaveBeenCalledTimes(1)
    expect(dispatchTool).toHaveBeenCalledWith("app_data_write", args)
  })

  it("a non data-plane tool is not affected", async () => {
    const { appRegistry, dispatchTool } = await uiPair()
    appRegistry.upsertApp({
      appId: "@x/a",
      dir: dirA,
      agents: [],
      workflows: [],
      unvalidatedAgentTools: [],
      ui: { path: join(dirA, "index.html"), tools: [...TOOLS, "app_list"] },
    })
    await performAppToolCall(
      appRegistry,
      { appId: "@x/a", tool: "app_list", args: { appId: "@x/b" } },
      { dispatchTool },
    )
    expect(dispatchTool).toHaveBeenCalledWith("app_list", { appId: "@x/b" })
  })
})
