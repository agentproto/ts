/**
 * Coverage for the `session_transcript` MCP tool, the read-side of the
 * transcript gap: `session_list` / `session_context_status` knew a session
 * existed but nothing served its actual conversation back. The tool reuses
 * the same normalised read path as `agentproto sessions export`, so the shape
 * matches. Exercises: full transcript, `limit` tail window, and the not-found
 * / no-transcript branches.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { registerSessionTools } from "../session-tools.js"
import { setDefaultSessionsBaseDir } from "../transcript-writer.js"

function parseToolJson(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text) as Record<string, unknown>
}

describe("session_transcript (MCP)", () => {
  let tmp: string
  let transcriptDir: string
  let registry: ReturnType<typeof createSessionsRegistry>

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "transcript-test-"))
    transcriptDir = join(tmp, "sessions")
    // Point the daemon's transcript base dir at the temp dir so the tool's
    // read path (exportDaemonEventsSession → sessionEventsPath with no baseDir)
    // resolves fixtures we write here, not ~/.agentproto/sessions.
    setDefaultSessionsBaseDir(transcriptDir)
    registry = createSessionsRegistry({
      persist: false,
      transcriptDir,
      sessionEvents: createSessionEventBus(),
    })
  })

  afterEach(() => {
    setDefaultSessionsBaseDir(undefined)
    rmSync(tmp, { recursive: true, force: true })
  })

  async function connectTools() {
    const server = new McpServer({ name: "transcript-test", version: "0.0.0" })
    registerSessionTools(server, { registry, workspace: process.cwd() })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "transcript-client", version: "0.0.0" })
    await client.connect(clientTransport)
    return client
  }

  function writeEvents(id: string, records: Array<Record<string, unknown>>): void {
    const dir = join(transcriptDir, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "events.jsonl"),
      records.map((r, i) => JSON.stringify({ seq: i + 1, ts: `2026-10-21T22:0${i}:00Z`, ...r })).join("\n") + "\n",
      "utf8",
    )
  }

  it("returns the normalised conversation (user / assistant / tool) for a session", async () => {
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: { sessionId: "x", async *send() {}, async cancel() {}, async close() {} } as never,
      adapterSlug: "opencode",
      model: "opencode/go/hy3",
    })
    writeEvents(desc.id, [
      { kind: "system-prompt", text: "You are the executor." },
      { kind: "user-prompt", text: "fix the build" },
      { kind: "text-delta", text: "looking at " },
      { kind: "text-delta", text: "the config" },
      { kind: "tool-call", toolName: "bash", arguments: JSON.stringify({ command: "pnpm build" }) },
      { kind: "turn-end", reason: "completed" },
    ])

    const client = await connectTools()
    const res = await client.callTool({ name: "session_transcript", arguments: { idOrName: desc.id } })
    const body = parseToolJson(res)
    expect(body.sessionId).toBe(desc.id)
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages.length).toBeGreaterThan(0)
    const roles = messages.map(m => m.role)
    expect(roles).toContain("user")
    expect(roles).toContain("assistant")
    const user = messages.find(m => m.role === "user")!
    expect(user.text).toBe("fix the build")
    // The exporter folds tool-call-records into the assistant message's
    // toolCalls (the raw `tool-call-record` line is intentionally dropped).
    const assistant = messages.find(m => m.role === "assistant")!
    const toolCalls = (assistant.toolCalls as Array<{ name: string; args: string }>) ?? []
    expect(toolCalls.some(tc => tc.name === "bash")).toBe(true)
  })

  it("`limit` keeps only the most recent N messages (tail window)", async () => {
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: { sessionId: "x", async *send() {}, async cancel() {}, async close() {} } as never,
      adapterSlug: "opencode",
      model: "opencode/go/hy3",
    })
    const records = Array.from({ length: 6 }, (_, i) => ({ kind: "user-prompt", text: `msg ${i}` }))
    writeEvents(desc.id, records)

    const client = await connectTools()
    const res = await client.callTool({ name: "session_transcript", arguments: { idOrName: desc.id, limit: 2 } })
    const body = parseToolJson(res)
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages.length).toBe(2)
    expect(messages[messages.length - 1]!.text).toBe("msg 5")
  })

  it("reports not-found for an unknown session id", async () => {
    const client = await connectTools()
    const res = await client.callTool({ name: "session_transcript", arguments: { idOrName: "nope" } })
    const body = parseToolJson(res) as { error?: string }
    expect((res as { isError?: boolean }).isError).toBe(true)
    expect(body.error).toMatch(/no session/)
  })

  it("returns an empty messages array when no transcript file exists", async () => {
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: { sessionId: "x", async *send() {}, async cancel() {}, async close() {} } as never,
      adapterSlug: "opencode",
      model: "opencode/go/hy3",
    })
    // no writeEvents → events.jsonl absent
    const client = await connectTools()
    const res = await client.callTool({ name: "session_transcript", arguments: { idOrName: desc.id } })
    const body = parseToolJson(res)
    expect(body.count).toBe(0)
    expect(body.messages).toEqual([])
  })
})
