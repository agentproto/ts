import { describe, it, expect } from "vitest"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { llmRequestyGenerator } from "../generators/llm-requesty.js"
import { runGenerators } from "../runner.js"
import type { CatalogSource, GeneratorContext } from "../types.js"

const HERE = dirname(fileURLToPath(import.meta.url))
// packages/catalog-sync/src/__tests__/ → packages/catalog-sync/snapshots/
const SNAPSHOTS_DIR = join(HERE, "..", "..", "snapshots")

const OUTPUT_PATH = "packages/model-catalog/src/llm/requesty-routes.generated.ts"
const LEDGER_PATH = "packages/catalog-sync/ledger/llm-requesty.json"

/**
 * OFFLINE context — reads the committed (REAL, live-fetched) snapshot from
 * disk. NEVER hits the network (refresh=false + a committed snapshot is the
 * contract). Used only for the structural / metadata / determinism checks
 * below that don't need hand-picked numbers.
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
// Covers exactly the unit-conversion + cache-gating rules this generator
// owns, independent of whatever the live Requesty catalog looks like on any
// given day. The first entry mirrors a REAL verified payload row (Requesty
// `/v1/models`, fetched 2026-07-17): note `supports_caching: false` despite
// a present `cached_price` — the multiplier must NOT be derived there.
const FIXTURE = {
  data: [
    {
      id: "sference/thinkingcap-qwen3.6-27b",
      input_price: 4e-7,
      output_price: 3e-6,
      cached_price: 2.6e-7,
      supports_caching: false,
    },
    // supports_caching: true → cacheReadMultiplier = cached/input = 0.25.
    {
      id: "anthropic/claude-sonnet-4-5-20250929",
      input_price: 3e-6,
      output_price: 1.5e-5,
      cached_price: 7.5e-7,
      supports_caching: true,
    },
    // No cached_price at all, supports_caching false → no multiplier.
    {
      id: "openai/gpt-4.1",
      input_price: 2e-6,
      output_price: 8e-6,
      supports_caching: false,
    },
    // Zero-priced route (both input and output) → skipped entirely.
    {
      id: "free/some-free-model",
      input_price: 0,
      output_price: 0,
      supports_caching: false,
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

/** Isolate one route's serialized block so cache-field assertions can't leak across entries. */
function entryBlock(src: string, id: string): string {
  const marker = `  ${JSON.stringify(id)}: {`
  const start = src.indexOf(marker)
  if (start === -1) throw new Error(`entry not found in output: ${id}`)
  const nextTop = src.indexOf('\n  "', start + marker.length)
  return nextTop === -1 ? src.slice(start) : src.slice(start, nextTop)
}

describe("llm:requesty generator — hand-written fixture", () => {
  it("emits the drop-in file plus its addedAt ledger", async () => {
    const files = await llmRequestyGenerator.generate(fixtureCtx())
    expect(Object.keys(files).sort()).toEqual([LEDGER_PATH, OUTPUT_PATH].sort())
  })

  it("converts per-token USD NUMBERS (not strings) to USD-per-1M", async () => {
    const files = await llmRequestyGenerator.generate(fixtureCtx())
    const src = files[OUTPUT_PATH]!

    // 4e-7 * 1e6 = 0.4, 3e-6 * 1e6 = 3 — matches the verified live payload
    // ($0.40/1M input, $3.00/1M output for sference/thinkingcap-qwen3.6-27b).
    const block = entryBlock(src, "sference/thinkingcap-qwen3.6-27b")
    expect(block).toContain("inputPer1M: 0.4")
    expect(block).toContain("outputPer1M: 3")
  })

  it("derives vendor from the id prefix (vendor/model)", async () => {
    const files = await llmRequestyGenerator.generate(fixtureCtx())
    const src = files[OUTPUT_PATH]!

    expect(entryBlock(src, "sference/thinkingcap-qwen3.6-27b")).toContain('vendor: "sference"')
    expect(entryBlock(src, "anthropic/claude-sonnet-4-5-20250929")).toContain('vendor: "anthropic"')
    expect(entryBlock(src, "openai/gpt-4.1")).toContain('vendor: "openai"')
  })

  it("emits cacheReadMultiplier ONLY when supports_caching is true", async () => {
    const files = await llmRequestyGenerator.generate(fixtureCtx())
    const src = files[OUTPUT_PATH]!

    // supports_caching: true, cached/input = 7.5e-7 / 3e-6 = 0.25.
    expect(entryBlock(src, "anthropic/claude-sonnet-4-5-20250929")).toContain(
      "cacheReadMultiplier: 0.25"
    )

    // supports_caching: false with a present cached_price → NOT emitted,
    // even though a naive "cached_price present" check would wrongly emit it.
    expect(entryBlock(src, "sference/thinkingcap-qwen3.6-27b")).not.toContain(
      "cacheReadMultiplier"
    )

    // supports_caching: false, no cached_price at all → NOT emitted.
    expect(entryBlock(src, "openai/gpt-4.1")).not.toContain("cacheReadMultiplier")
  })

  it("never emits a cacheWriteMultiplier field (no cache-write price in this source)", async () => {
    const files = await llmRequestyGenerator.generate(fixtureCtx())
    const src = files[OUTPUT_PATH]!
    // Only asserts no FIELD is emitted — the header comment legitimately
    // mentions the name in prose to explain why it's absent.
    expect(src).not.toMatch(/^\s*cacheWriteMultiplier:/m)
  })

  it("skips zero-priced routes entirely", async () => {
    const files = await llmRequestyGenerator.generate(fixtureCtx())
    const src = files[OUTPUT_PATH]!
    expect(src).not.toContain("free/some-free-model")
  })

  it("emits deterministic, sorted key ordering (routes and providers list)", async () => {
    const files = await llmRequestyGenerator.generate(fixtureCtx())
    const src = files[OUTPUT_PATH]!

    const idxAnthropic = src.indexOf('"anthropic/claude-sonnet-4-5-20250929"')
    const idxOpenai = src.indexOf('"openai/gpt-4.1"')
    const idxSference = src.indexOf('"sference/thinkingcap-qwen3.6-27b"')
    expect(idxAnthropic).toBeGreaterThan(0)
    expect(idxOpenai).toBeGreaterThan(idxAnthropic)
    expect(idxSference).toBeGreaterThan(idxOpenai)

    const idxProvAnthropic = src.indexOf('"anthropic",')
    const idxProvOpenai = src.indexOf('"openai",')
    const idxProvSference = src.indexOf('"sference",')
    expect(idxProvAnthropic).toBeGreaterThan(0)
    expect(idxProvOpenai).toBeGreaterThan(idxProvAnthropic)
    expect(idxProvSference).toBeGreaterThan(idxProvOpenai)
  })

  it("is byte-identical across two generate calls (deterministic)", async () => {
    const a = await llmRequestyGenerator.generate(fixtureCtx())
    const b = await llmRequestyGenerator.generate(fixtureCtx())
    expect(a).toEqual(b)
  })

  it("declares the expected generator metadata", () => {
    expect(llmRequestyGenerator.name).toBe("llm:requesty")
    expect(llmRequestyGenerator.modality).toBe("llm")
    expect(llmRequestyGenerator.sources[0]?.id).toBe("llm-requesty")
    expect(llmRequestyGenerator.sources[0]?.url).toBe("https://router.requesty.ai/v1/models")
  })
})

describe("llm:requesty generator — real committed snapshot (offline)", () => {
  it("parses the full committed snapshot and emits a well-formed REQUESTY_ROUTES map", async () => {
    const files = await llmRequestyGenerator.generate(offlineCtx())
    const src = files[OUTPUT_PATH]!
    expect(src).toBeTruthy()

    expect(src).toContain('import type { LLMPricing } from "./catalog.js"')
    expect(src).toContain("export const REQUESTY_ROUTES: Record<string, LLMPricing> = {")
    expect(src).toContain("export const REQUESTY_PROVIDERS: readonly string[] = [")

    const entryCount = (src.match(/inputPer1M:/g) ?? []).length
    expect(entryCount).toBeGreaterThanOrEqual(1)

    // Spot-check the real verified entry from the live payload.
    expect(entryBlock(src, "sference/thinkingcap-qwen3.6-27b")).toContain("inputPer1M: 0.4")
  })

  it("generates the same bytes whether called directly or through the runner (write=false)", async () => {
    const direct = await llmRequestyGenerator.generate(offlineCtx())
    const { files } = await runGenerators([llmRequestyGenerator], {
      refresh: false,
      write: false,
    })
    expect(files).toEqual(direct)
  })
})
