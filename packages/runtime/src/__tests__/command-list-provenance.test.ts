/**
 * Unit tests confirming `command_list` (session-tools.ts) surfaces the
 * `origin`/`callerSessionId` provenance fields stamped by `recordCommand`
 * (sessions.ts) — command-tools.test.ts covers command_execute's own
 * origin-defaulting/passthrough; this covers the read-back path a caller
 * actually uses to see it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"

async function buildHarness(
  registry: SessionsRegistry,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerSessionTools(server, { registry })

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

describe("command_list — provenance fields", () => {
  let workspace: string
  let registry: SessionsRegistry

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "command-list-provenance-"))
    registry = createSessionsRegistry({ persistPath: join(workspace, "sessions.json"), persist: false })
  })

  afterEach(() => {
    registry.shutdown()
    rmSync(workspace, { recursive: true, force: true })
  })

  it("exposes origin and callerSessionId on rows that have them", async () => {
    const withProvenance = registry.recordCommand({
      workspaceSlug: "default",
      cwd: workspace,
      command: "echo",
      args: ["hi"],
      exitCode: 0,
      signal: null,
      durationMs: 1,
      stdout: "hi\n",
      stderr: "",
      origin: "cron",
      callerSessionId: "sess_deadbeef",
    })
    const bare = registry.recordCommand({
      workspaceSlug: "default",
      cwd: workspace,
      command: "echo",
      args: ["bye"],
      exitCode: 0,
      signal: null,
      durationMs: 1,
      stdout: "bye\n",
      stderr: "",
    })

    const { client, close } = await buildHarness(registry)
    const result = await client.callTool({ name: "command_list", arguments: {} })
    const { sessions } = JSON.parse(textOf(result)) as { sessions: Array<Record<string, unknown>> }

    const withProvRow = sessions.find(s => s.id === withProvenance.id)
    expect(withProvRow).toMatchObject({ origin: "cron", callerSessionId: "sess_deadbeef" })

    const bareRow = sessions.find(s => s.id === bare.id)
    expect(bareRow?.origin).toBeUndefined()
    expect(bareRow?.callerSessionId).toBeUndefined()

    await close()
  })
})
