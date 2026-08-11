/**
 * Tests for conversation-export.ts — the WRITE side of the cross-adapter
 * pivot. Evidence of correctness is a **round-trip**: write an
 * `ExportedSession` to a fake claude-code store under a fake $HOME, then read
 * it back with the existing claude-code reader (`exportClaudeCodeSession`)
 * and assert the messages come back identical. Fixtures reuse the same fake
 * `$HOME` technique as conversation-read.test.ts / conversation-store.test.ts.
 */

import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  writeToNativeStore,
  exportConversation,
  registerConversationExportTool,
} from "../conversation-export.js"
import { exportClaudeCodeSession, type ExportedSession, type ExportedMessage } from "../transcript-export.js"
import type { SessionDescriptor, SessionsRegistry } from "../sessions.js"

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

function setupFakeHome(): void {
  originalHome = process.env.HOME
  fakeHome = mkdtempSync(join(tmpdir(), "conversation-export-"))
  process.env.HOME = fakeHome
}

/** Minimal descriptor — only the fields conversation-export.ts reads. */
function makeDescriptor(overrides: Partial<SessionDescriptor>): SessionDescriptor {
  return {
    id: "sess_test",
    kind: "agent-cli",
    workspaceSlug: "default",
    command: "claude",
    pid: 1234,
    status: "running",
    startedAt: "2026-05-13T09:00:00.000Z",
    ...overrides,
  }
}

function stubRegistry(desc: SessionDescriptor | undefined): SessionsRegistry {
  return {
    findByIdOrName: () => desc,
  } as unknown as SessionsRegistry
}

/** The message pattern `exportDaemonEventsSession` actually produces: an
 *  assistant turn (text + reasoning + tool calls) followed by its tool
 *  result role message. */
const SAMPLE_MESSAGES: ExportedMessage[] = [
  { role: "user", text: "hello world" },
  {
    role: "assistant",
    text: "let me check the file",
    reasoning: "I should read the file first",
    toolCalls: [{ name: "Read", args: JSON.stringify({ path: "/tmp/a.txt" }) }],
  },
  { role: "tool", text: "contents of /tmp/a.txt" },
  {
    role: "assistant",
    text: "I can see it now. There is nothing further to check.",
    reasoning: "The contents are visible.",
  },
]

// ── write + round-trip through the claude-code reader ─────────────────

describe("writeToNativeStore claude-code round-trips through exportClaudeCodeSession", () => {
  it("returns the queue-operation header with the conversation id and a resume command", async () => {
    setupFakeHome()
    const cwd = "/my/proj"
    const session: ExportedSession = { meta: { source: "daemon-events" }, messages: SAMPLE_MESSAGES }

    const result = await writeToNativeStore(session, "claude-code", { cwd })

    expect(result.adapter).toBe("claude-code")
    expect(result.conversationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    // cwd-slug encoding matches claude's own rule; path sits under fake $HOME.
    const encoded = "/my/proj".replace(/[^a-zA-Z0-9]/g, "-")
    expect(result.path).toBe(join(fakeHome, ".claude", "projects", encoded, `${result.conversationId}.jsonl`))
    expect(result.resumeCommand).toBe(`claude --resume ${result.conversationId}`)
    expect(result.messageCount).toBe(SAMPLE_MESSAGES.length)
  })

  it("writing then reading back preserves every message (assistant + tool_result)", async () => {
    setupFakeHome()
    const cwd = "/a/b"
    const session: ExportedSession = { meta: { source: "daemon-events" }, messages: SAMPLE_MESSAGES }

    const result = await writeToNativeStore(session, "claude-code", { cwd })
    const back = await exportClaudeCodeSession(result.conversationId, cwd)

    // Reader rewrites meta.source, but messages must round-trip unchanged.
    expect(back.messages).toEqual(SAMPLE_MESSAGES)
  })

  it("round-trips a plain text-only conversation", async () => {
    setupFakeHome()
    const cwd = "/c"
    const messages: ExportedMessage[] = [
      { role: "user", text: "Hi" },
      { role: "assistant", text: "Hello! How can I help?" },
      { role: "user", text: "Explain the plan" },
      { role: "assistant", text: "Here is the plan." },
    ]
    const result = await writeToNativeStore({ meta: {}, messages }, "claude-code", { cwd })
    const back = await exportClaudeCodeSession(result.conversationId, cwd)
    expect(back.messages).toEqual(messages)
  })

  it("round-trips assistant text + thinking + a tool call and its result", async () => {
    setupFakeHome()
    const cwd = "/dotted.path/.hidden"
    const messages: ExportedMessage[] = [
      { role: "user", text: "read the config" },
      {
        role: "assistant",
        reasoning: "Need the config path",
        text: "Reading the config.",
        toolCalls: [{ name: "Grep", args: JSON.stringify({ pattern: "key", path: "." }) }],
      },
      { role: "tool", text: "/dotted.path/.hidden:1:  key = value" },
    ]
    const result = await writeToNativeStore({ meta: {}, messages }, "claude-code", { cwd })
    const back = await exportClaudeCodeSession(result.conversationId, cwd)
    expect(back.messages).toEqual(messages)
  })

  it("surfaces a system message as a [system]-prefixed user line (not silently dropped)", async () => {
    setupFakeHome()
    const cwd = "/d"
    const result = await writeToNativeStore(
      { meta: {}, messages: [{ role: "user", text: "go" }, { role: "system", text: "interrupted" }] },
      "claude-code",
      { cwd },
    )
    const back = await exportClaudeCodeSession(result.conversationId, cwd)
    expect(back.messages).toEqual([
      { role: "user", text: "go" },
      { role: "user", text: "[system] interrupted" },
    ])
  })
})

// ── exportConversation (core) ─────────────────────────────────────────

describe("exportConversation", () => {
  it("resolves the session, exports its transcript, and returns the resume handle", async () => {
    setupFakeHome()
    const cwd = "/my/proj"
    const desc = makeDescriptor({ id: "sess_abc", cwd, adapterSlug: "claude-code" })
    const stubExport = async (_sid: string, _d?: SessionDescriptor): Promise<ExportedSession> => ({
      meta: { source: "daemon-events" },
      messages: [{ role: "user", text: "hello" }],
    })

    const result = await exportConversation(stubRegistry(desc), { sessionId: "sess_abc", target: "claude-code" }, stubExport)

    expect(result.adapter).toBe("claude-code")
    expect(result.resumeCommand).toBe(`claude --resume ${result.conversationId}`)
    expect(result.path).toBe(join(fakeHome, ".claude", "projects", "/my/proj".replace(/[^a-zA-Z0-9]/g, "-"), `${result.conversationId}.jsonl`))
  })

  it("honors an explicit cwd override instead of the session's cwd", async () => {
    setupFakeHome()
    const desc = makeDescriptor({ id: "sess_abc", cwd: "/session/dir" })
    const stubExport = async (): Promise<ExportedSession> => ({
      meta: {},
      messages: [{ role: "user", text: "hi" }],
    })

    const result = await exportConversation(
      stubRegistry(desc),
      { sessionId: "sess_abc", target: "claude-code", cwd: "/override/dir" },
      stubExport,
    )
    expect(result.path.startsWith(join(fakeHome, ".claude", "projects", "/override/dir".replace(/[^a-zA-Z0-9]/g, "-")))).toBe(true)
  })

  it("throws a clean error for an unknown session", async () => {
    setupFakeHome()
    await expect(
      exportConversation(stubRegistry(undefined), { sessionId: "nope", target: "claude-code" }),
    ).rejects.toThrow('session "nope" not found')
  })
})

// ── MCP tool registration ─────────────────────────────────────────────

async function makeClient(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0.0.1" })
  await client.connect(clientTransport)
  return client
}

describe("registerConversationExportTool", () => {
  it("registers and calls through to the writer, returning the result JSON", async () => {
    setupFakeHome()
    const cwd = "/tool"
    const desc = makeDescriptor({ id: "sess_tool", cwd, adapterSlug: "claude-code" })
    const server = new McpServer({ name: "test-conversation-export", version: "0.0.1" })
    registerConversationExportTool(server, {
      registry: stubRegistry(desc),
      exportFn: async () => ({ meta: {}, messages: [{ role: "user", text: "hello tool" }] }),
    })
    const client = await makeClient(server)

    const result = await client.callTool({
      name: "conversation_export",
      arguments: { sessionId: "sess_tool", target: "claude-code" },
    })
    expect(result.isError).toBeFalsy()
    const content0 = (result.content as Array<{ type: string; text: string }>)[0]
    const parsed = JSON.parse(content0?.text ?? "{}") as {
      conversationId: string
      path: string
      adapter: string
      resumeCommand: string
    }
    expect(parsed.adapter).toBe("claude-code")
    expect(parsed.resumeCommand).toBe(`claude --resume ${parsed.conversationId}`)

    await client.close()
  })

  it("returns isError for an unknown session", async () => {
    setupFakeHome()
    const server = new McpServer({ name: "test-conversation-export-2", version: "0.0.1" })
    registerConversationExportTool(server, { registry: stubRegistry(undefined) })
    const client = await makeClient(server)

    const result = await client.callTool({
      name: "conversation_export",
      arguments: { sessionId: "nope", target: "claude-code" },
    })
    expect(result.isError).toBe(true)
    const content0 = (result.content as Array<{ type: string; text: string }>)[0]
    expect(content0?.text).toContain("not found")

    await client.close()
  })
})