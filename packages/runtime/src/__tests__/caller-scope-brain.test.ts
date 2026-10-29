/**
 * T15 on `workspace_brain_query`: a hit ingested from a session grounded in a
 * sealed sibling, or above the caller's sealed wall, never reaches the answer;
 * the filter runs before the top-K cut. A missing or unknown caller is
 * refused. Shared fixture; a fake brain whose provider ranks perso hits first.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"

import { HOST_CALLER, type CallerScope } from "../caller-scope.js"
import { registerBrainTools } from "../brain-tools.js"
import { SESSION, buildCallerFixture, type CallerFixture } from "./caller-scope-fixture.js"

interface Hit {
  sourceId: string
  chunkId: string
  text: string
  score: number
  metadata: Record<string, unknown>
}

let fx: CallerFixture
beforeEach(() => {
  fx = buildCallerFixture()
})
afterEach(() => fx.cleanup())

function hit(sessionId: string | undefined, text: string, score: number): Hit {
  return {
    sourceId: `src_${text}`,
    chunkId: `chunk_${text}`,
    text,
    score,
    metadata: sessionId === undefined ? {} : { sessionId },
  }
}

/** Ranked best-first: eight perso hits outrank everything else. */
function corpus(): Hit[] {
  const persoHits = Array.from({ length: 8 }, (_, i) => hit(SESSION.perso, `PERSO-HIT-${i}`, 100 - i))
  return [
    ...persoHits,
    hit(SESSION.userRoot, "ROOT-HIT", 50),
    hit(SESSION.notes, "NOTES-HIT", 40),
    hit(SESSION.agentik, "COMPANY-HIT", 30),
    hit(SESSION.free, "FREE-HIT", 20),
    hit("sess_orphan", "ORPHAN-HIT", 15),
    hit(undefined, "NO-SESSION-HIT", 10),
  ]
}

async function harness(callerScope: CallerScope | undefined) {
  const queries: Array<{ query: string; topK?: number }> = []
  const brains = {
    getBrain: () => ({
      getProvider: () => ({
        query: async (q: { query: string; topK?: number }) => {
          queries.push(q)
          const hits = corpus().slice(0, q.topK ?? 10)
          return { hits, tookMs: 1, engine: "fake", modeUsed: "keyword" }
        },
      }),
      status: async () => ({ indexed: 1 }),
      ingestPending: async () => ({ ingested: 0 }),
      ingestSession: async () => ({ ok: true }),
    }),
    resolveWorkspace: async () => undefined,
    resolveWorkspaceSlug: () => "default",
  }
  const server = new McpServer({ name: "brain-test", version: "0.0.0" })
  registerBrainTools(server, { brains, registry: fx.sessions, callerScope, scopes: fx.scopes } as never)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "brain-client", version: "0.0.0" })
  await client.connect(clientTransport)
  async function call(name: string, args: Record<string, unknown>) {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    return { isError: result.isError === true, text: result.content[0]!.text }
  }
  const texts = async (args: Record<string, unknown>): Promise<string[]> => {
    const res = await call("workspace_brain_query", args)
    expect(res.isError, res.text).toBe(false)
    return (JSON.parse(res.text) as { hits: Hit[] }).hits.map((h) => h.text)
  }
  return { call, texts, queries, close: () => client.close() }
}

describe("workspace_brain_query", () => {
  it("a sealed node gets neither its sibling's, the ancestor's nor another tree's hits", async () => {
    const h = await harness(fx.caller(SESSION.perso))
    const hits = await h.texts({ query: "anything", topK: 50 })
    // A session grounded in no declared tree is outside every wall, so its hit stays.
    expect(hits.every((t) => t.startsWith("PERSO-HIT") || t === "FREE-HIT"), hits.join(",")).toBe(true)
    expect(hits).toContain("PERSO-HIT-0")
    for (const walled of ["ROOT-HIT", "NOTES-HIT", "COMPANY-HIT"]) expect(hits).not.toContain(walled)
    await h.close()
  })

  it("an isolated sibling does not get the sealed node's hits, and keeps its own and its ancestor's", async () => {
    const h = await harness(fx.caller(SESSION.notes))
    const hits = await h.texts({ query: "anything", topK: 50 })
    expect(hits).not.toEqual(expect.arrayContaining([expect.stringMatching(/^PERSO-HIT/)]))
    expect(hits).toEqual(expect.arrayContaining(["NOTES-HIT", "ROOT-HIT"]))
    expect(hits).not.toContain("COMPANY-HIT")
    await h.close()
  })

  it("the ancestor loses the sealed descendant's hits", async () => {
    const h = await harness(fx.caller(SESSION.userRoot))
    const hits = await h.texts({ query: "anything", topK: 50 })
    expect(hits.some((t) => t.startsWith("PERSO-HIT"))).toBe(false)
    expect(hits).toEqual(expect.arrayContaining(["ROOT-HIT", "NOTES-HIT"]))
    await h.close()
  })

  it("drops a hit whose session cannot be placed, never serves it unscoped", async () => {
    const h = await harness(fx.caller(SESSION.notes))
    const hits = await h.texts({ query: "anything", topK: 50 })
    expect(hits).not.toContain("ORPHAN-HIT")
    expect(hits).not.toContain("NO-SESSION-HIT")
    await h.close()
  })

  it("filters before the top-K cut: the best allowed hit still comes back at topK 1", async () => {
    const h = await harness(fx.caller(SESSION.notes))
    const hits = await h.texts({ query: "anything", topK: 1 })
    expect(hits).toEqual(["ROOT-HIT"])
    await h.close()
  })

  it("a host call and a session in no declared tree are not filtered", async () => {
    for (const caller of [HOST_CALLER, fx.caller(SESSION.free)]) {
      const h = await harness(caller)
      const hits = await h.texts({ query: "anything", topK: 50 })
      expect(hits).toHaveLength(14)
      expect(hits).toContain("PERSO-HIT-0")
      expect(h.queries.at(-1)?.topK).toBe(50)
      await h.close()
    }
  })
})

describe("a missing or unknown caller is refused", () => {
  const calls: Array<[string, Record<string, unknown>]> = [
    ["workspace_brain_query", { query: "anything" }],
    ["workspace_brain_status", {}],
    ["workspace_brain_ingest", {}],
  ]
  for (const [label, scope] of [
    ["an unknown caller id", () => fx.caller(SESSION.ghost)],
    ["no caller scope at all", () => undefined],
  ] as const) {
    for (const [tool, args] of calls) {
      it(`${tool} refuses ${label}`, async () => {
        const h = await harness(scope())
        const res = await h.call(tool, args)
        expect(res.isError).toBe(true)
        expect(res.text).toMatch(/refused/i)
        expect(res.text).not.toContain("PERSO-HIT")
        expect(h.queries).toHaveLength(0)
        await h.close()
      })
    }
  }
})
