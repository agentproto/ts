import { describe, it, expect } from "vitest"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { llmHuggingfaceGenerator } from "../generators/llm-huggingface.js"
import { runGenerators } from "../runner.js"
import type { CatalogSource, GeneratorContext } from "../types.js"

const HERE = dirname(fileURLToPath(import.meta.url))
// packages/catalog-sync/src/__tests__/ → packages/catalog-sync/snapshots/
const SNAPSHOTS_DIR = join(HERE, "..", "..", "snapshots")

const OUTPUT_PATH = "packages/model-catalog/src/llm/huggingface-routes.generated.ts"

/**
 * OFFLINE context — reads the committed (REAL, live-fetched) snapshot from
 * disk. NEVER hits the network (refresh=false + a committed snapshot is the
 * contract) — see the STOP-si-fork pre-answer in SPEC-upstream.md: tests run
 * on the pinned snapshot only.
 */
function offlineCtx(): GeneratorContext {
  return {
    refresh: false,
    async fetchSource(src) {
      const snap = join(SNAPSHOTS_DIR, `${src.id}.json`)
      return JSON.parse(await readFile(snap, "utf8"))
    },
  }
}

// ── Small hand-written fixture ───────────────────────────────────────────
// Covers exactly the filtering + shape rules this generator owns, independent
// of whatever the live HuggingFace router catalog looks like on any given
// day. Mirrors a REAL verified payload shape (router.huggingface.co/v1/models,
// fetched 2026-07-18): sparse provider entries (only provider+status), a
// non-live provider mixed with live ones, and a model with zero live
// providers.
const FIXTURE = {
  data: [
    {
      id: "google/gemma-4-31B-it",
      owned_by: "google",
      providers: [
        {
          provider: "novita",
          status: "live",
          context_length: 262144,
          pricing: { input: 0.14, output: 0.4 },
          supports_tools: true,
        },
        // Sparse — no pricing, no context_length.
        {
          provider: "cerebras",
          status: "live",
          supports_tools: true,
        },
        // Non-live — must be dropped entirely.
        {
          provider: "retired-host",
          status: "error",
          context_length: 999999,
          pricing: { input: 9, output: 9 },
        },
        {
          provider: "deepinfra",
          status: "live",
          context_length: 262144,
          pricing: { input: 0.13, output: 0.38 },
          supports_tools: true,
          supports_structured_output: false,
        },
      ],
    },
    // Zero live providers → the whole model is skipped.
    {
      id: "some-org/no-live-providers",
      providers: [{ provider: "retired-host", status: "error" }],
    },
    // No `providers` field at all → skipped (treated as zero live providers).
    {
      id: "some-org/no-providers-field",
    },
  ],
}

function fixtureCtx(): GeneratorContext {
  return {
    refresh: false,
    async fetchSource(_src: CatalogSource): Promise<unknown> {
      return FIXTURE
    },
  }
}

/** Isolate one model's serialized block so field assertions can't leak across entries. */
function entryBlock(src: string, id: string): string {
  const marker = `  ${JSON.stringify(id)}: {`
  const start = src.indexOf(marker)
  if (start === -1) throw new Error(`entry not found in output: ${id}`)
  const nextTop = src.indexOf('\n  "', start + marker.length)
  return nextTop === -1 ? src.slice(start) : src.slice(start, nextTop)
}

describe("llm:huggingface generator — hand-written fixture", () => {
  it("emits exactly one drop-in file at the model-catalog path", async () => {
    const files = await llmHuggingfaceGenerator.generate(fixtureCtx())
    expect(Object.keys(files)).toEqual([OUTPUT_PATH])
  })

  it("keeps only status === live providers, case-preserving the wire id", async () => {
    const files = await llmHuggingfaceGenerator.generate(fixtureCtx())
    const src = files[OUTPUT_PATH]!
    const block = entryBlock(src, "google/gemma-4-31B-it")

    expect(block).toContain('wireId: "google/gemma-4-31B-it"')
    expect(block).toContain('provider: "novita"')
    expect(block).toContain('provider: "cerebras"')
    expect(block).toContain('provider: "deepinfra"')
    expect(block).not.toContain("retired-host")
  })

  it("emits sparse provider entries with only provider/status when other fields are absent", async () => {
    const files = await llmHuggingfaceGenerator.generate(fixtureCtx())
    const src = files[OUTPUT_PATH]!
    const block = entryBlock(src, "google/gemma-4-31B-it")

    const cerebrasStart = block.indexOf('provider: "cerebras"')
    const cerebrasBlock = block.slice(cerebrasStart, block.indexOf("}", cerebrasStart))
    expect(cerebrasBlock).toContain('status: "live"')
    expect(cerebrasBlock).not.toContain("contextLength")
    expect(cerebrasBlock).not.toContain("inputPer1M")
    expect(cerebrasBlock).not.toContain("outputPer1M")
    // supports_tools: true WAS present on the source row, so it IS emitted.
    expect(cerebrasBlock).toContain("supportsTools: true")
  })

  it("passes pricing through as USD-per-1M numbers (no unit conversion)", async () => {
    const files = await llmHuggingfaceGenerator.generate(fixtureCtx())
    const src = files[OUTPUT_PATH]!
    const block = entryBlock(src, "google/gemma-4-31B-it")

    const deepinfraStart = block.indexOf('provider: "deepinfra"')
    const deepinfraBlock = block.slice(deepinfraStart, block.indexOf("},", deepinfraStart))
    expect(deepinfraBlock).toContain("inputPer1M: 0.13")
    expect(deepinfraBlock).toContain("outputPer1M: 0.38")
    expect(deepinfraBlock).toContain("contextLength: 262144")
    expect(deepinfraBlock).toContain("supportsStructuredOutput: false")
  })

  it("sorts providers within a model alphabetically", async () => {
    const files = await llmHuggingfaceGenerator.generate(fixtureCtx())
    const src = files[OUTPUT_PATH]!
    const block = entryBlock(src, "google/gemma-4-31B-it")

    const idxCerebras = block.indexOf('provider: "cerebras"')
    const idxDeepinfra = block.indexOf('provider: "deepinfra"')
    const idxNovita = block.indexOf('provider: "novita"')
    expect(idxCerebras).toBeGreaterThan(0)
    expect(idxDeepinfra).toBeGreaterThan(idxCerebras)
    expect(idxNovita).toBeGreaterThan(idxDeepinfra)
  })

  it("skips models with zero live providers, including when `providers` is absent", async () => {
    const files = await llmHuggingfaceGenerator.generate(fixtureCtx())
    const src = files[OUTPUT_PATH]!
    expect(src).not.toContain("no-live-providers")
    expect(src).not.toContain("no-providers-field")
  })

  it("is byte-identical across two generate calls (deterministic)", async () => {
    const a = await llmHuggingfaceGenerator.generate(fixtureCtx())
    const b = await llmHuggingfaceGenerator.generate(fixtureCtx())
    expect(a).toEqual(b)
  })

  it("declares the expected generator metadata", () => {
    expect(llmHuggingfaceGenerator.name).toBe("llm:huggingface")
    expect(llmHuggingfaceGenerator.modality).toBe("llm")
    expect(llmHuggingfaceGenerator.sources[0]?.id).toBe("llm-huggingface")
    expect(llmHuggingfaceGenerator.sources[0]?.url).toBe(
      "https://router.huggingface.co/v1/models"
    )
  })
})

describe("llm:huggingface generator — real committed snapshot (offline)", () => {
  it("parses the full committed snapshot and emits a well-formed HUGGINGFACE_ROUTES map", async () => {
    const files = await llmHuggingfaceGenerator.generate(offlineCtx())
    const src = files[OUTPUT_PATH]!
    expect(src).toBeTruthy()

    expect(src).toContain("export interface HuggingFaceRouteProvider {")
    expect(src).toContain("export interface HuggingFaceRoute {")
    expect(src).toContain("export const HUGGINGFACE_ROUTES: Record<string, HuggingFaceRoute> = {")

    const entryCount = (src.match(/wireId:/g) ?? []).length
    expect(entryCount).toBeGreaterThanOrEqual(1)

    // Every emitted provider carries at least provider + status.
    const providerCount = (src.match(/provider: "/g) ?? []).length
    const statusCount = (src.match(/status: "live"/g) ?? []).length
    expect(statusCount).toBe(providerCount)
  })

  it("emits keys in sorted order", async () => {
    const files = await llmHuggingfaceGenerator.generate(offlineCtx())
    const src = files[OUTPUT_PATH]!
    const ids = [...src.matchAll(/^ {2}"([^"]+)": \{$/gm)].map((m) => m[1]!)
    expect(ids).toEqual([...ids].sort())
    expect(ids.length).toBeGreaterThan(1)
  })

  it("generates the same bytes whether called directly or through the runner (write=false)", async () => {
    const direct = await llmHuggingfaceGenerator.generate(offlineCtx())
    const { files } = await runGenerators([llmHuggingfaceGenerator], {
      refresh: false,
      write: false,
    })
    expect(files).toEqual(direct)
  })
})
