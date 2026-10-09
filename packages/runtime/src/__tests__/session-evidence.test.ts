/**
 * `session_evidence` (FIX-9B) — the read-only judge input: the transcript
 * turn reader, and the MCP tool's wiring (descriptor flags + worktree view).
 */

import { describe, it, expect } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { readRecentTurnsSync, readRecentToolCallRecordsSync, summarizeToolCalls } from "../session-evidence.js"
import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"
import type { WorktreeStatusLister } from "../worktree-status.js"

function writeEvents(records: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "session-evidence-"))
  const path = join(dir, "events.jsonl")
  writeFileSync(path, records.map(r => JSON.stringify(r)).join("\n") + "\n")
  return path
}

describe("readRecentTurnsSync", () => {
  it("rebuilds user/assistant turns, joining text deltas across tool calls", () => {
    const path = writeEvents([
      { kind: "user-prompt", text: "fix the bug" },
      { kind: "text-delta", text: "Looking " },
      { kind: "tool-call", name: "read_file" },
      { kind: "tool-result" },
      { kind: "text-delta", text: "— fixed, PR #3 opened." },
      { kind: "turn-end" },
      { kind: "user-prompt", text: "thanks" },
      { kind: "text-delta", text: "You're welcome." },
      { kind: "turn-end" },
    ])
    expect(readRecentTurnsSync(path)).toEqual([
      { role: "user", text: "fix the bug" },
      { role: "assistant", text: "Looking — fixed, PR #3 opened." },
      { role: "user", text: "thanks" },
      { role: "assistant", text: "You're welcome." },
    ])
  })

  it("keeps only the newest turns within the turn count and char budget", () => {
    const records: unknown[] = []
    for (let i = 0; i < 20; i++) {
      records.push({ kind: "user-prompt", text: `q${i} ${"x".repeat(400)}` })
      records.push({ kind: "text-delta", text: `a${i} ${"y".repeat(400)}` })
      records.push({ kind: "turn-end" })
    }
    const turns = readRecentTurnsSync(writeEvents(records))
    expect(turns.length).toBeLessThanOrEqual(10)
    expect(turns.reduce((n, t) => n + t.text.length, 0)).toBeLessThanOrEqual(3_000)
    // Newest turns survive whole; the oldest kept one is trimmed to fit.
    expect(turns.at(-1)!.text.startsWith("a19")).toBe(true)
    expect(turns.at(-2)!.text.startsWith("q19")).toBe(true)
    expect(turns[0]!.text.endsWith("…")).toBe(true)
  })

  it("returns [] for a missing file", () => {
    expect(readRecentTurnsSync("/nonexistent/events.jsonl")).toEqual([])
  })
})

describe("tool-call stats (PR 3 enrichment)", () => {
  it("reads the tail tool-call-record lines and strips the kind", () => {
    const path = writeEvents([
      { kind: "tool-call-record", tool: "Bash", command: "rg sentinel a.md", ts: "2026-10-02T10:00:00Z" },
      { kind: "text-delta", text: "x" },
      { kind: "tool-call-record", tool: "Read", args: ["src/b.ts"], isError: true },
    ])
    expect(readRecentToolCallRecordsSync(path)).toEqual([
      { tool: "Bash", command: "rg sentinel a.md", ts: "2026-10-02T10:00:00Z" },
      { tool: "Read", args: ["src/b.ts"], isError: true },
    ])
  })

  it("summarizes distinct/repeated calls, the top command, and file re-reads", () => {
    const records = [
      { tool: "Bash", command: "rg sentinel a.md" },
      { tool: "Bash", command: "rg sentinel a.md" },
      { tool: "Bash", command: "rg sentinel a.md" },
      { tool: "Bash", command: "ls" },
      { tool: "Bash", command: "cat src/repeat.ts" },
      { tool: "Bash", command: "cat src/repeat.ts" },
    ]
    const s = summarizeToolCalls(records)
    expect(s).toMatchObject({ total: 6, distinct: 3, repeated: 3, ratio: 0.5, topCommandCount: 3, distinctReads: 2, repeatedReads: 3 })
    expect(s.topCommand).toContain("rg sentinel a.md")
  })

  it("returns ratio 1 for no calls", () => {
    expect(summarizeToolCalls([])).toMatchObject({ total: 0, distinct: 0, ratio: 1, topCommand: null })
  })
})

function idleAgentSession(id: string): AgentSessionLike {
  return {
    sessionId: id,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      await new Promise(() => {})
    },
    async cancel() {},
    async close() {},
  }
}

describe("session_evidence tool", () => {
  it("returns the descriptor flags, recent turns and the worktree view — read-only", async () => {
    const lister: WorktreeStatusLister = async (_root, options) =>
      (options?.paths ?? []).map(path => ({
        path,
        branch: "wt/feature",
        class: "hold" as const,
        reclaimable: false,
        dirty: true,
        changes: { modified: 2, staged: 0, untracked: 1 },
        base: { ref: "origin/main", ahead: 3, behind: 1 },
        pr: { state: "open", number: 42, url: "https://example.test/42" },
        sessions: [],
        liveness: { state: "sessions", sessionCount: 1 },
      }))
    const registry = createSessionsRegistry({ persist: false, transcriptDir: mkdtempSync(join(tmpdir(), "session-evidence-tx-")) })
    const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
    registerSessionTools(server, { registry, workspace: process.cwd(), listWorktreeStatuses: lister })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "test-client", version: "0" })
    await client.connect(clientTransport)

    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp/wt/feature",
      agentSession: idleAgentSession("acp-ev"),
      adapterSlug: "claude-code",
    })
    const rt = registry.get(desc.id)!
    rt.keepAlive = true
    rt.origin = "cron:job"
    rt.worktreePath = "/tmp/wt/feature"
    rt.mainRepoPath = "/tmp/repo"
    rt.lastActivityAt = new Date(Date.now() - 45 * 60_000).toISOString()
    // The registry derives `eventsPath` from its transcript dir on every
    // read — write the transcript where it says it lives.
    const eventsPath = registry.get(desc.id)!.eventsPath!
    mkdirSync(dirname(eventsPath), { recursive: true })
    writeFileSync(
      eventsPath,
      [
        { kind: "user-prompt", text: "ship it" },
        { kind: "text-delta", text: "PR #42 opened." },
        { kind: "turn-end" },
      ].map(r => JSON.stringify(r)).join("\n") + "\n",
    )

    const res = await client.callTool({ name: "session_evidence", arguments: { sessionId: desc.id } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ev = JSON.parse((res as any).content[0].text)
    expect(ev).toMatchObject({
      sessionId: desc.id,
      cwd: "/tmp/wt/feature",
      adapter: "claude-code",
      keepAlive: true,
      awaitingInput: false,
      origin: "cron:job",
      pullRequests: { opened: 0, merged: 0, state: "open" },
      turns: [
        { role: "user", text: "ship it" },
        { role: "assistant", text: "PR #42 opened." },
      ],
      worktree: {
        branch: "wt/feature",
        dirty: true,
        changes: { modified: 2, staged: 0, untracked: 1 },
        ahead: 3,
        behind: 1,
        pr: { state: "open", number: 42, url: "https://example.test/42" },
      },
    })
    expect(ev.idleMinutes).toBeGreaterThanOrEqual(44)
    expect(registry.get(desc.id)!.status).toBe("running")

    const missing = await client.callTool({ name: "session_evidence", arguments: { sessionId: "nope" } })
    expect((missing as { isError?: boolean }).isError).toBe(true)

    await client.close()
    registry.shutdown()
  })
})
