/**
 * Tests for conversation-locate-tool.ts — the `conversation_locate` MCP verb
 * that does the bidirectional session ↔ native-transcript lookup. Fixtures
 * are a `conversations.jsonl` per workspace bucket under a fake $HOME (same
 * technique as the CLI's conversation-locate.test.ts), exercised through the
 * real MCP transport (McpServer/InMemoryTransport/Client, same as
 * conversation-read.test.ts).
 */

import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { registerConversationLocateTool } from "../conversation-locate-tool.js"

// ── fixtures ──────────────────────────────────────────────────────────

let fakeHome: string
let originalHome: string | undefined

afterEach(() => {
  if (fakeHome) rmSync(fakeHome, { recursive: true, force: true })
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
})

function setupFakeHome(): string {
  originalHome = process.env.HOME
  fakeHome = mkdtempSync(join(tmpdir(), "conversation-locate-tool-"))
  process.env.HOME = fakeHome
  return fakeHome
}

/** Build a claude-jsonl index record against the current fakeHome. */
function buildRecord(home: string) {
  const nativePath = join(home, ".claude", "projects", "-tmp-proj", "11111111-0000-0000-0000-000000000001.jsonl")
  const subagentPath = join(home, ".claude", "projects", "-tmp-proj", "sub", "aaaaaaaa-3333.jsonl")
  const record = {
    sessionId: "sess_locate_tool",
    workspace: "default",
    cwd: "/tmp/proj",
    adapterSlug: "claude-code",
    adapterSessionId: "11111111-0000-0000-0000-000000000001",
    native: {
      kind: "claude-jsonl",
      path: nativePath,
      subagents: [subagentPath],
    },
    agentprotoTranscript: join(home, ".agentproto", "sessions", "sess_locate_tool", "events.jsonl"),
    startedAt: "2026-07-18T10:00:00.000Z",
  }
  const bucketDir = join(home, ".agentproto", "workspaces", "default")
  mkdirSync(bucketDir, { recursive: true })
  writeFileSync(join(bucketDir, "conversations.jsonl"), JSON.stringify(record) + "\n")
  return { record, nativePath, subagentPath }
}

async function makeClient(): Promise<Client> {
  const server = new McpServer({ name: "test-conversation-locate", version: "0.0.1" })
  registerConversationLocateTool(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0.0.1" })
  await client.connect(clientTransport)
  return client
}

interface LocateBody {
  found: boolean
  workspace?: string
  matchedBy?: "sessionId" | "nativePath"
  matchedSubagentPath?: string
  reason?: string
}

async function callLocate(client: Client, target: string): Promise<LocateBody> {
  const result = await client.callTool({
    name: "conversation_locate",
    arguments: { target },
  })
  const content0 = (result.content as Array<{ type: string; text: string }>)[0]
  return JSON.parse(content0?.text ?? "{}") as LocateBody
}

// ── tests ─────────────────────────────────────────────────────────────

describe("conversation_locate tool — MCP transport", () => {
  it("is listed in tools/list with a description mentioning transcript lookup", async () => {
    setupFakeHome()
    const client = await makeClient()
    const result = await client.listTools()
    const tool = result.tools.find(t => t.name === "conversation_locate")
    expect(tool).toBeDefined()
    expect(tool?.description?.toLowerCase()).toContain("transcript")
    await client.close()
  })

  it("forward: locates by sessionId", async () => {
    const home = setupFakeHome()
    buildRecord(home)
    const client = await makeClient()
    const body = await callLocate(client, "sess_locate_tool")
    expect(body.found).toBe(true)
    expect(body.matchedBy).toBe("sessionId")
    expect(body.workspace).toBe("default")
    await client.close()
  })

  it("reverse: locates by the native jsonl path", async () => {
    const home = setupFakeHome()
    const { nativePath } = buildRecord(home)
    const client = await makeClient()
    const body = await callLocate(client, nativePath)
    expect(body.found).toBe(true)
    expect(body.matchedBy).toBe("nativePath")
    expect(body.matchedSubagentPath).toBeUndefined()
    await client.close()
  })

  it("reverse: locates a subagent transcript path and marks it matched", async () => {
    const home = setupFakeHome()
    const { subagentPath } = buildRecord(home)
    const client = await makeClient()
    const body = await callLocate(client, subagentPath)
    expect(body.found).toBe(true)
    expect(body.matchedBy).toBe("nativePath")
    expect(body.matchedSubagentPath).toBe(subagentPath)
    await client.close()
  })

  it("nothing matches as sessionId or path → found:false, no MCP error", async () => {
    const home = setupFakeHome()
    buildRecord(home)
    const client = await makeClient()
    const result = await client.callTool({
      name: "conversation_locate",
      arguments: { target: "sess_totally_unknown" },
    })
    expect(result.isError).toBeFalsy()
    const body = await callLocate(client, "sess_totally_unknown")
    expect(body.found).toBe(false)
    expect(body.reason).toBeTruthy()
    await client.close()
  })

  it("isError stays false with no buckets on disk at all", async () => {
    setupFakeHome() // empty home, no workspaces bucket
    const client = await makeClient()
    const result = await client.callTool({
      name: "conversation_locate",
      arguments: { target: "sess_ghost" },
    })
    expect(result.isError).toBeFalsy()
    await client.close()
  })
})
