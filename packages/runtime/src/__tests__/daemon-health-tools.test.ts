/**
 * Unit tests for daemon_health MCP tool.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerDaemonHealthTools } from "../daemon-health-tools.js"
import { withDeferredTools } from "../deferred-tools.js"

async function buildHarness(
  workspace: string,
  registered: readonly string[],
  startedAt: number,
  deferred = false,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const { server: rawServer } = await createMcpServer({
    specs: [],
    name: "test",
    version: "0",
  })
  const server = deferred
    ? withDeferredTools(rawServer, { alwaysOn: new Set(["daemon_health"]) })
    : rawServer
  registerDaemonHealthTools(server, { workspace, registered, startedAt })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)

  return { client, close: () => client.close() }
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text: string }> }).content
  return content?.[0]?.text ?? "{}"
}

describe("daemon_health", () => {
  let workspace: string
  let startedAt: number

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "daemon-health-test-"))
    startedAt = Date.now() - 1234
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it("lists as daemon_health", async () => {
    const { client, close } = await buildHarness(workspace, ["foo"], startedAt)
    const tools = await client.listTools()
    expect(tools.tools.map(t => t.name)).toContain("daemon_health")
    await close()
  })

  it("returns ok, alive, workspace, registered, and a non-negative uptimeMs", async () => {
    const registered = ["spec-a", "spec-b"]
    const { client, close } = await buildHarness(workspace, registered, startedAt)

    const before = Date.now()
    const result = await client.callTool({ name: "daemon_health", arguments: {} })
    const after = Date.now()

    expect(result.isError).toBeFalsy()
    const body = JSON.parse(textOf(result))
    expect(body).toMatchObject({
      alive: true,
      status: "ok",
      workspace,
      registered,
    })
    expect(body.uptimeMs).toBeGreaterThanOrEqual(before - startedAt)
    expect(body.uptimeMs).toBeLessThanOrEqual(after - startedAt)

    await close()
  })

  it("returns empty registered when no specs are registered", async () => {
    const { client, close } = await buildHarness(workspace, [], startedAt)
    const result = await client.callTool({ name: "daemon_health", arguments: {} })
    const body = JSON.parse(textOf(result))
    expect(body.registered).toEqual([])
    await close()
  })

  it("remains visible when deferred tools hide the rest of the surface", async () => {
    const { client, close } = await buildHarness(workspace, ["foo"], startedAt, true)
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name)).toContain("daemon_health")
    await close()
  })
})
