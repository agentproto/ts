/**
 * `transcript_search` / `transcript_read` — the read side of conversation
 * resumption, exercised through the real MCP surface.
 *
 * A restarted session starts with an EMPTY transcript: its history lives
 * in its predecessors'. These tools walk that lineage and return dated,
 * bounded excerpts — never a whole transcript.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
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

  async function call(name: string, args: Record<string, unknown>): Promise<any> {
    const server = new McpServer({ name: "t", version: "0" })
    registerSessionTools(server, { registry: reg, workspace: tmp })
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

  it("finds a predecessor's transcript after a restart and dates the hits", async () => {
    const oldId = spawn()
    await reg.sendPrompt(oldId, "the mission is to ship the parser")
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

  it("never returns a whole transcript — the excerpt is bounded", async () => {
    const oldId = spawn()
    await reg.sendPrompt(oldId, "x".repeat(5000) + " needle " + "y".repeat(5000))
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
    const newId = spawn(oldId)
    await reg.sendPrompt(newId, "back at it")

    const res = await call("transcript_read", { sessionId: newId })
    const body = payload(res)
    expect(body.excerpts.length).toBeGreaterThanOrEqual(2)
    expect(body.excerpts[0].ts).toBeTruthy()
    expect(body.excerpts.some((e: any) => e.excerpt.includes("ship the parser"))).toBe(true)
  })

  it("filters a read by query", async () => {
    const oldId = spawn()
    await reg.sendPrompt(oldId, "alpha")
    const newId = spawn(oldId)
    await reg.sendPrompt(newId, "beta")

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
})
