/**
 * `kb_query` / `kb_ingest` proven against an in-memory FAKE
 * `IKnowledgeProvider` — no live backend, no vector store, no graph db. This
 * is the whole point of the pure contract package: the tools and their
 * bodies are exercised end-to-end (real ingest→query round-trip) before any
 * real backend exists. Mirrors code-brain's `ask-codebase.test.ts`
 * (`packages/code-brain/src/__tests__/ask-codebase.test.ts`).
 */

import { describe, it, expect } from "vitest"
import { validateInput, validateOutput, validateContext } from "@agentproto/tool"
import { kbQueryTool } from "../tools/kb-query.tool.js"
import { kbIngestTool } from "../tools/kb-ingest.tool.js"
import { kbQueryBuiltin } from "../provider/bodies/kb-query.body.js"
import { kbIngestBuiltin } from "../provider/bodies/kb-ingest.body.js"
import { knowledgeEngineProvider } from "../provider/knowledge-engine-provider.js"
import { createFakeKnowledgeProvider } from "../testing/fake-knowledge-provider.js"
import type { IKnowledgeProvider } from "../provider.js"

/**
 * Drive a tool the way a provider runtime would: validate input + context
 * against the contract, run the typed body, validate output. Exercises the
 * real contract boundary, not just the raw function.
 */
async function runIngest(rawInput: unknown, provider: IKnowledgeProvider) {
  const input = validateInput(kbIngestTool, rawInput)
  if (!input.ok) throw new Error(`input invalid: ${input.error.message}`)
  const context = validateContext(kbIngestTool, { knowledgeEngine: provider })
  if (!context.ok) throw new Error(`context invalid: ${context.error.message}`)

  const controller = new AbortController()
  const output = await kbIngestBuiltin.body({
    input: input.value,
    context: context.value,
    driverCtx: { secrets: {}, authState: "unknown" },
    signal: controller.signal,
  })
  // `validateOutput` returns the value directly and throws on mismatch.
  return validateOutput(kbIngestTool, output)
}

async function runQuery(rawInput: unknown, provider: IKnowledgeProvider) {
  const input = validateInput(kbQueryTool, rawInput)
  if (!input.ok) throw new Error(`input invalid: ${input.error.message}`)
  const context = validateContext(kbQueryTool, { knowledgeEngine: provider })
  if (!context.ok) throw new Error(`context invalid: ${context.error.message}`)

  const controller = new AbortController()
  const output = await kbQueryBuiltin.body({
    input: input.value,
    context: context.value,
    driverCtx: { secrets: {}, authState: "unknown" },
    signal: controller.signal,
  })
  // `validateOutput` returns the value directly and throws on mismatch.
  return validateOutput(kbQueryTool, output)
}

describe("kb_query / kb_ingest contract metadata", () => {
  it("kb_query is read-only, auto approval, idempotent, risk 0", () => {
    expect(kbQueryTool.mutates).toEqual([])
    expect(kbQueryTool.approval).toBe("auto")
    expect(kbQueryTool.idempotent).toBe(true)
    expect(kbQueryTool.riskLevel).toBe(0)
  })

  it("kb_ingest declares its mutation and is non-idempotent", () => {
    expect(kbIngestTool.mutates).toEqual(["knowledge_source"])
    expect(kbIngestTool.idempotent).toBe(false)
    expect(kbIngestTool.riskLevel).toBe(1)
  })

  it("kb_query defaults `mode` to undefined (engine picks)", () => {
    const parsed = validateInput(kbQueryTool, { query: "anything" })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.mode).toBeUndefined()
  })
})

describe("kb_ingest → engine.ingest", () => {
  it("ingests a text source and returns its record", async () => {
    const provider = createFakeKnowledgeProvider()
    const out = await runIngest(
      {
        kind: "text",
        uri: "mem://note-1",
        title: "Retry policy",
        content: "Retries use exponential backoff with jitter.",
        metadata: { channel: "eng" },
      },
      provider,
    )

    expect(out.source.id).toBe("src-1")
    expect(out.source.kind).toBe("text")
    expect(out.source.status).toBe("ready")
    expect(out.source.bytes).toBeGreaterThan(0)
    expect(out.source.metadata).toEqual({ channel: "eng" })
    expect(out.answer).toContain("Retry policy")

    // Round-trips: the ingested source is retrievable.
    const fetched = await provider.getSource("src-1")
    expect(fetched?.uri).toBe("mem://note-1")
  })
})

describe("kb_query → engine.query (real ingest→query round-trip)", () => {
  it("returns hits for content that was ingested", async () => {
    const provider = createFakeKnowledgeProvider()
    await runIngest(
      { kind: "text", uri: "mem://a", title: "Backoff", content: "exponential backoff jitter" },
      provider,
    )
    await runIngest(
      { kind: "text", uri: "mem://b", title: "Auth", content: "oauth token refresh" },
      provider,
    )

    const out = await runQuery({ query: "backoff", mode: "vector" }, provider)

    expect(out.engine).toBe("fake-knowledge")
    expect(out.modeUsed).toBe("vector")
    expect(out.hits.length).toBe(1)
    expect(out.hits[0]?.sourceId).toBe("src-1")
    expect(out.answer).toContain("result(s)")
  })

  it("honors topK", async () => {
    const provider = createFakeKnowledgeProvider()
    await runIngest({ kind: "text", uri: "mem://1", content: "alpha token" }, provider)
    await runIngest({ kind: "text", uri: "mem://2", content: "alpha token" }, provider)
    await runIngest({ kind: "text", uri: "mem://3", content: "alpha token" }, provider)

    const out = await runQuery({ query: "alpha", topK: 2 }, provider)
    expect(out.hits.length).toBe(2)
  })

  it("honors minScore", async () => {
    const provider = createFakeKnowledgeProvider()
    // Single occurrence ⇒ score 1/3 ≈ 0.33; filter it out with a higher floor.
    await runIngest({ kind: "text", uri: "mem://1", content: "solo mention" }, provider)
    const out = await runQuery({ query: "solo", minScore: 0.9 }, provider)
    expect(out.hits.length).toBe(0)
    expect(out.answer).toBe("No results for: solo")
  })

  it("falls back an unsupported mode to vector and echoes modeUsed truthfully", async () => {
    const provider = createFakeKnowledgeProvider()
    await runIngest({ kind: "text", uri: "mem://g", content: "graph traversal note" }, provider)

    // The fake has graphTraversal:false — requesting 'graph' must fall back.
    const out = await runQuery({ query: "graph", mode: "graph" }, provider)
    expect(out.modeUsed).toBe("vector")
    expect(out.hits.length).toBe(1)
  })

  it("treats mode 'none' as the cold-start sentinel — empty hits, modeUsed 'none'", async () => {
    const provider = createFakeKnowledgeProvider()
    await runIngest({ kind: "text", uri: "mem://x", content: "present but skipped" }, provider)

    const out = await runQuery({ query: "present", mode: "none" }, provider)
    expect(out.modeUsed).toBe("none")
    expect(out.hits).toEqual([])
    expect(out.answer).toContain("No recall this turn")
  })

  it("renders an empty-result answer when nothing matches", async () => {
    const provider = createFakeKnowledgeProvider()
    const out = await runQuery({ query: "nonexistent" }, provider)
    expect(out.hits).toEqual([])
    expect(out.answer).toBe("No results for: nonexistent")
  })
})

describe("provider builtin binding", () => {
  it("binds BOTH the kb_query and kb_ingest contract handles", () => {
    expect(kbQueryBuiltin.tool.id).toBe("kb_query")
    expect(kbIngestBuiltin.tool.id).toBe("kb_ingest")
    const toolIds = knowledgeEngineProvider.implements.map((i) => i.tool)
    expect(toolIds).toContain("kb_query")
    expect(toolIds).toContain("kb_ingest")
  })
})
