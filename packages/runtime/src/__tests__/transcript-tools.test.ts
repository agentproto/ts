/**
 * `transcript_search` / `transcript_read`, the read side of conversation
 * resumption, exercised through the real MCP surface.
 *
 * A restarted session starts with an EMPTY transcript: its history lives
 * in its predecessors'. These tools walk that lineage and return dated,
 * bounded excerpts, never a whole transcript.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
  type SessionsRegistry,
} from "../sessions.js"
import { registerSessionTools } from "../session-tools.js"

interface FakeHarness extends AgentSessionLike {
  prompts: string[]
}

function fakeHarness(): FakeHarness {
  const harness: FakeHarness = {
    sessionId: "acp-fake",
    prompts: [],
    async *send(message): AsyncIterable<AgentStreamEvent> {
      const text = (Array.isArray(message) ? message : [message])
        .map(b => (typeof b === "string" ? b : ((b as { text?: string } | undefined)?.text ?? "")))
        .join("")
      harness.prompts.push(text)
      yield { kind: "text-delta", text: "ok" }
      yield { kind: "usage_update", size: 1000, used: 100 }
      yield { kind: "turn-end" }
    },
    async cancel() {},
    async close() {},
  }
  return harness
}

describe("transcript_search / transcript_read", () => {
  let tmp: string
  let reg: SessionsRegistry

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "transcript-tools-"))
    reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
  })
  afterEach(() => {
    reg.shutdown()
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  const spawn = (resumedFrom?: string): string =>
    reg.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: fakeHarness(),
      adapterSlug: "fake",
      ...(resumedFrom ? { resumedFrom } : {}),
    }).id

  async function call(
    name: string,
    args: Record<string, unknown>,
    callerSessionId?: string,
  ): Promise<any> {
    const server = new McpServer({ name: "t", version: "0" })
    registerSessionTools(server, {
      registry: reg,
      workspace: tmp,
      ...(callerSessionId ? { callerSessionId } : {}),
    })
    const [c, s] = InMemoryTransport.createLinkedPair()
    await server.connect(s)
    const client = new Client({ name: "t-client", version: "0" })
    await client.connect(c)
    try {
      return await client.callTool({ name, arguments: args })
    } finally {
      await client.close()
    }
  }

  const payload = (res: any): any => JSON.parse((res.content?.[0]?.text ?? "{}") as string)

  /** The transcript append stream flushes asynchronously: wait until a
   *  session's record containing `text` is on disk before reading it. */
  const onDisk = (sessionId: string, text: string) =>
    vi.waitFor(async () => {
      const body = payload(await call("transcript_search", { sessionId, query: text, maxResults: 50 }))
      expect(body.hits.some((h: any) => h.sessionId === sessionId)).toBe(true)
    })

  it("finds a predecessor's transcript after a restart and dates the hits", async () => {
    const oldId = spawn()
    await reg.sendPrompt(oldId, "the mission is to ship the parser")
    await onDisk(oldId, "ship the parser")
    const newId = spawn(oldId)

    const res = await call("transcript_search", { sessionId: newId, query: "parser" })
    const body = payload(res)
    expect(body.isError).toBeUndefined()
    expect(body.chain.map((c: any) => c.sessionId)).toEqual([newId, oldId])
    expect(body.chain[1].via).toBe("resumedFrom")
    expect(body.hits.length).toBeGreaterThan(0)
    expect(body.hits[0].sessionId).toBe(oldId)
    expect(body.hits[0].ts).toBeTruthy()
    expect(body.hits[0].excerpt).toContain("parser")
  })

  it("never returns a whole transcript, the excerpt is bounded", async () => {
    const oldId = spawn()
    await reg.sendPrompt(oldId, "x".repeat(5000) + " needle " + "y".repeat(5000))
    await onDisk(oldId, "needle")
    const newId = spawn(oldId)

    const res = await call("transcript_search", {
      sessionId: newId,
      query: "needle",
      excerptChars: 200,
    })
    const body = payload(res)
    const hit = body.hits[0]
    expect(hit.excerpt.length).toBeLessThanOrEqual(202)
    expect(hit.textLength).toBeGreaterThan(hit.excerpt.length)
  })

  it("reads dated excerpts along the chain", async () => {
    const oldId = spawn()
    await reg.sendPrompt(oldId, "the mission is to ship the parser")
    await onDisk(oldId, "ship the parser")
    const newId = spawn(oldId)
    await reg.sendPrompt(newId, "back at it")
    await onDisk(newId, "back at it")

    const res = await call("transcript_read", { sessionId: newId })
    const body = payload(res)
    expect(body.excerpts.length).toBeGreaterThanOrEqual(2)
    expect(body.excerpts[0].ts).toBeTruthy()
    expect(body.excerpts.some((e: any) => e.excerpt.includes("ship the parser"))).toBe(true)
  })

  it("filters a read by query", async () => {
    const oldId = spawn()
    await reg.sendPrompt(oldId, "alpha")
    await onDisk(oldId, "alpha")
    const newId = spawn(oldId)
    await reg.sendPrompt(newId, "beta")
    await onDisk(newId, "beta")

    const res = await call("transcript_read", { sessionId: newId, query: "alpha" })
    const body = payload(res)
    expect(body.excerpts.length).toBe(1)
    expect(body.excerpts[0].excerpt).toContain("alpha")
  })

  it("reports a clear error when there is no session to look back from", async () => {
    const res = await call("transcript_search", { query: "parser" })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain("no session given")
  })

  it("errors on an unknown ref instead of falling back to the caller", async () => {
    const callerId = spawn()
    await reg.sendPrompt(callerId, "the caller's own parser notes")
    await onDisk(callerId, "parser notes")

    for (const ref of [{ sessionId: "sess_missing" }, { idOrName: "nope" }, { slug: "nope" }]) {
      const search = await call("transcript_search", { ...ref, query: "parser" }, callerId)
      expect(search.isError).toBe(true)
      expect(JSON.stringify(search.content)).toMatch(/no session .*found/)
      const read = await call("transcript_read", { ...ref }, callerId)
      expect(read.isError).toBe(true)
      expect(JSON.stringify(read.content)).toMatch(/no session .*found/)
    }

    // No ref at all still falls back on the calling session.
    const own = payload(await call("transcript_search", { query: "parser" }, callerId))
    expect(own.sessionId).toBe(callerId)
  })

  it("stops walking the lineage once the total character budget is spent", async () => {
    let prev: string | undefined
    for (let i = 0; i < 5; i++) {
      const id = spawn(prev)
      await reg.sendPrompt(id, `needle ${i} ` + "z".repeat(140))
      prev = id
    }
    const head = prev!
    // Wait for every transcript of the chain to reach disk (async append).
    await vi.waitFor(async () => {
      const all = payload(await call("transcript_search", { sessionId: head, query: "needle" }))
      expect(all.hits.length).toBe(5)
    })

    const search = payload(
      await call("transcript_search", {
        sessionId: head,
        query: "needle",
        excerptChars: 150,
        totalChars: 200,
      }),
    )
    const searchSpent = search.hits.reduce((n: number, h: any) => n + h.excerpt.length, 0)
    expect(searchSpent).toBeLessThanOrEqual(200)
    expect(search.hits.length).toBe(1)
    expect(search.truncated).toBe(true)

    const read = payload(
      await call("transcript_read", {
        sessionId: head,
        query: "needle",
        excerptChars: 150,
        totalChars: 200,
      }),
    )
    const readSpent = read.excerpts.reduce((n: number, e: any) => n + e.excerpt.length, 0)
    expect(readSpent).toBeLessThanOrEqual(200)
    expect(read.excerpts.length).toBe(1)
    expect(read.truncated).toBe(true)
  })

  it("applies `since` to the target's transcript only, not its predecessors'", async () => {
    const oldId = spawn()
    await reg.sendPrompt(oldId, "alpha")
    const newId = spawn(oldId)
    await reg.sendPrompt(newId, "beta one")
    await reg.sendPrompt(newId, "beta two")

    // The append stream flushes asynchronously: wait until the target's own
    // records are on disk before taking its cursor.
    let targetSeqs: number[] = []
    let oldSeqs: number[] = []
    await vi.waitFor(async () => {
      const all = payload(await call("transcript_read", { sessionId: newId, maxRecords: 50 }))
      targetSeqs = all.excerpts
        .filter((e: any) => e.sessionId === newId)
        .map((e: any) => e.seq as number)
      oldSeqs = all.excerpts
        .filter((e: any) => e.sessionId === oldId)
        .map((e: any) => e.seq as number)
      expect(targetSeqs.some(n => n >= 2)).toBe(true)
      expect(oldSeqs.length).toBeGreaterThan(0)
    })
    const since = Math.max(...targetSeqs)
    // Seqs are per file: the predecessor's numbers overlap the target's.
    expect(Math.max(...oldSeqs)).toBeLessThanOrEqual(since)

    const body = payload(await call("transcript_read", { sessionId: newId, since, maxRecords: 50 }))
    expect(body.excerpts.filter((e: any) => e.sessionId === newId)).toEqual([])
    expect(body.excerpts.some((e: any) => e.sessionId === oldId && e.excerpt.includes("alpha"))).toBe(
      true,
    )
  })
})
