/**
 * CorpusAdapterCore driven THROUGH the `@agentproto/knowledge-engine`
 * `kb_query` / `kb_ingest` tools — the same contract boundary a provider
 * runtime crosses (validateInput → typed body → validateOutput). Proves the
 * corpus adapter is a drop-in `IKnowledgeProvider` for the pure engine's
 * tools: a `kb_query` returns AIP-10-hydrated hits, and `kb_ingest` surfaces
 * the corpus engine's public-write rejection.
 *
 * Mirrors the engine package's own `kb-tools.test.ts`, but injects
 * CorpusAdapterCore (over the marketing fixture + a stub backing) as the
 * `knowledgeEngine` context instead of the in-memory fake.
 */

import { describe, expect, it } from "vitest"
import {
  validateContext,
  validateInput,
  validateOutput,
} from "@agentproto/tool"
import {
  kbIngestBuiltin,
  kbIngestTool,
  kbQueryBuiltin,
  kbQueryTool,
  type IKnowledgeProvider,
  type KnowledgeHit,
} from "@agentproto/knowledge-engine"
import { CorpusAdapterCore } from "../adapter.js"
import { loadM0FixtureFs, makeStubProvider } from "./_helpers.js"

/**
 * Drive a tool the way a provider runtime would: validate input + context
 * against the contract, run the typed body, validate output. Exercises the
 * real contract boundary, not just the raw function.
 */
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
  return validateOutput(kbQueryTool, output)
}

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
  return validateOutput(kbIngestTool, output)
}

function corpusOverFixture(hits: readonly KnowledgeHit[]): IKnowledgeProvider {
  const fs = loadM0FixtureFs()
  const { provider: backing } = makeStubProvider({ hitsForQuery: () => hits })
  return new CorpusAdapterCore({
    fs,
    workspacePath: "",
    backing,
    nowMs: () => Date.parse("2026-05-22T14:30:00Z"),
  })
}

describe("kb_query → CorpusAdapterCore.query (AIP-10 hydration through the tool)", () => {
  it("returns a hydrated hit with corpus provenance in metadata", async () => {
    const provider = corpusOverFixture([
      {
        sourceId: "stub-1",
        chunkId: "stub-1-0",
        text: "Open with a popularly-held belief, then contradict it.",
        score: 0.91,
        metadata: {
          corpus: { entrySlug: "contrarian-short-form-hooks", chunkIndex: 0 },
        },
      },
    ])

    const out = await runQuery({ query: "contrarian hook" }, provider)

    expect(out.engine).toBe("corpus")
    expect(out.hits.length).toBe(1)
    const meta = out.hits[0]!.metadata as Record<string, unknown>
    expect(meta.entrySlug).toBe("contrarian-short-form-hooks")
    expect(meta.entryPath).toBe(
      "entries/patterns/2026/contrarian-short-form-hooks.md"
    )
    expect(meta.status).toBe("active")
    expect(meta.domain).toBe("marketing")
    // Rendered answer names the corpus engine + the (backing) hit.
    expect(out.answer).toContain("engine 'corpus'")
    expect(out.answer).toContain("result(s)")
  })

  it("renders an empty answer when the backing engine returns no hits", async () => {
    const provider = corpusOverFixture([])
    const out = await runQuery({ query: "nothing matches" }, provider)
    expect(out.hits).toEqual([])
    expect(out.answer).toBe("No results for: nothing matches")
  })
})

describe("kb_ingest → CorpusAdapterCore.ingest (public write rejected)", () => {
  it("surfaces the corpus engine's ingest rejection through the tool body", async () => {
    const provider = corpusOverFixture([])
    await expect(
      runIngest(
        { kind: "text", uri: "mem://note", content: "should be rejected" },
        provider
      )
    ).rejects.toThrow(/not permitted/)
  })
})
