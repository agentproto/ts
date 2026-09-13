import { describe, it, expect } from "vitest"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  llmOpencodeGoGenerator,
  llmOpencodeZenGenerator,
  vendorForOpencodeModelId,
} from "../generators/llm-opencode.js"
import { runGenerators } from "../runner.js"
import type { CatalogSource, GeneratorContext } from "../types.js"

const HERE = dirname(fileURLToPath(import.meta.url))
// packages/catalog-sync/src/__tests__/ → packages/catalog-sync/snapshots/
const SNAPSHOTS_DIR = join(HERE, "..", "..", "snapshots")

const GO_OUTPUT = "packages/model-catalog/src/llm/opencode-go-routes.generated.ts"
const GO_LEDGER = "packages/catalog-sync/ledger/llm-opencode-go.json"
const GO_SNAPSHOT = "packages/catalog-sync/snapshots/llm-opencode-go.json"
const ZEN_OUTPUT = "packages/model-catalog/src/llm/opencode-zen-routes.generated.ts"
const ZEN_LEDGER = "packages/catalog-sync/ledger/llm-opencode-zen.json"
const ZEN_SNAPSHOT = "packages/catalog-sync/snapshots/llm-opencode-zen.json"

/**
 * OFFLINE context — reads the committed (REAL, live-fetched then projected)
 * snapshot from disk. NEVER hits the network (refresh=false + a committed
 * snapshot is the contract).
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
// Covers exactly the rules this generator owns, independent of what the live
// models.dev lineup looks like on any given day. Shaped like the real payload:
// the whole map is keyed by PROVIDER id, prices are USD per 1M tokens ALREADY,
// and the per-model wire surface is discriminated by `provider.npm`.
const FIXTURE = {
  // An unrelated provider, present exactly as it is in the real 213-provider
  // payload — the generator must ignore it rather than choke on it.
  anthropic: {
    id: "anthropic",
    models: { "claude-opus-4-8": { id: "claude-opus-4-8", cost: { input: 5, output: 25 } } },
  },
  "opencode-go": {
    id: "opencode-go",
    name: "OpenCode Go",
    api: "https://opencode.ai/zen/go/v1",
    env: ["OPENCODE_API_KEY"],
    models: {
      // Per-1M prices used VERBATIM (no ×1e6 — that's Requesty's unit, not
      // this one), cache multipliers relative to input: 0.26/1.4 and 0/…
      "glm-5.3": {
        id: "glm-5.3",
        family: "glm",
        release_date: "2026-08-14",
        cost: { input: 1.4, output: 4.4, cache_read: 0.26 },
      },
      // Anthropic wire surface + a cache_write price → both multipliers.
      "qwen3.8-flash": {
        id: "qwen3.8-flash",
        family: "qwen",
        release_date: "2026-08-26",
        provider: { npm: "@ai-sdk/anthropic" },
        cost: { input: 0.15, output: 0.47, cache_read: 0.015, cache_write: 0.3 },
      },
      // OpenAI Responses surface — NOT an Anthropic-surface id.
      "grok-4.5": {
        id: "grok-4.5",
        family: "grok",
        release_date: "2026-07-08",
        provider: { npm: "@ai-sdk/openai" },
        cost: { input: 2, output: 6 },
      },
      // Genuinely free: kept (zero is the truth on this endpoint), but a
      // 0/0 cache ratio is NaN so no multiplier may be emitted.
      "ox-alpha-free": {
        id: "ox-alpha-free",
        release_date: "2026-08-21",
        cost: { input: 0, output: 0, cache_read: 0 },
      },
      // No published price at all → skipped (a fabricated 0 would read as free).
      "unpriced-preview": { id: "unpriced-preview", release_date: "2026-09-01" },
    },
  },
  opencode: {
    id: "opencode",
    name: "OpenCode Zen",
    api: "https://opencode.ai/zen/v1",
    env: ["OPENCODE_API_KEY"],
    models: {
      "claude-sonnet-5": {
        id: "claude-sonnet-5",
        family: "claude-sonnet",
        release_date: "2026-06-30",
        provider: { npm: "@ai-sdk/anthropic" },
        cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
      },
      "gemini-3-pro": {
        id: "gemini-3-pro",
        release_date: "2025-11-18",
        provider: { npm: "@ai-sdk/google" },
        cost: { input: 2, output: 12, cache_read: 0.2 },
      },
    },
  },
}

function fixtureCtx(): GeneratorContext {
  return {
    refresh: false,
    async fetchSource(_src: CatalogSource): Promise<unknown> {
      return FIXTURE
    },
  }
}

/** Isolate one route's serialized block so per-entry assertions can't leak. */
function entryBlock(src: string, id: string): string {
  const marker = `  ${JSON.stringify(id)}: {`
  const start = src.indexOf(marker)
  if (start === -1) throw new Error(`entry not found in output: ${id}`)
  const nextTop = src.indexOf('\n  "', start + marker.length)
  return nextTop === -1 ? src.slice(start) : src.slice(start, nextTop)
}

describe("llm:opencode-go generator — hand-written fixture", () => {
  it("emits the route table, its addedAt ledger, and the pruned snapshot", async () => {
    const files = await llmOpencodeGoGenerator.generate(fixtureCtx())
    expect(Object.keys(files).sort()).toEqual([GO_LEDGER, GO_OUTPUT, GO_SNAPSHOT].sort())
  })

  it("keys routes by <provider>/<bare-id>, not <vendor>/<product>", async () => {
    const files = await llmOpencodeGoGenerator.generate(fixtureCtx())
    const src = files[GO_OUTPUT]!
    // This is the form opencode's own config uses, the form the runtime derives
    // the billing endpoint from, and the form the resolver looks up.
    expect(src).toContain('"opencode-go/glm-5.3"')
    expect(src).not.toContain('"z-ai/glm-5.3"')
  })

  it("uses per-1M prices VERBATIM (no per-token ×1e6 conversion)", async () => {
    const files = await llmOpencodeGoGenerator.generate(fixtureCtx())
    const block = entryBlock(files[GO_OUTPUT]!, "opencode-go/glm-5.3")
    expect(block).toContain("inputPer1M: 1.4")
    expect(block).toContain("outputPer1M: 4.4")
  })

  it("derives cache multipliers relative to the input price", async () => {
    const files = await llmOpencodeGoGenerator.generate(fixtureCtx())
    const src = files[GO_OUTPUT]!
    // 0.26 / 1.4 = 0.185714 (rounded to 6dp); no cache_write → no write field.
    const glm = entryBlock(src, "opencode-go/glm-5.3")
    expect(glm).toContain("cacheReadMultiplier: 0.185714")
    expect(glm).not.toContain("cacheWriteMultiplier")
    // 0.015 / 0.15 = 0.1 and 0.3 / 0.15 = 2.
    const qwen = entryBlock(src, "opencode-go/qwen3.8-flash")
    expect(qwen).toContain("cacheReadMultiplier: 0.1")
    expect(qwen).toContain("cacheWriteMultiplier: 2")
  })

  it("keeps a genuinely free model but emits NO cache multiplier for it", async () => {
    const files = await llmOpencodeGoGenerator.generate(fixtureCtx())
    const block = entryBlock(files[GO_OUTPUT]!, "opencode-go/ox-alpha-free")
    // Zero is the truth on this endpoint, not a missing price — unlike the
    // Requesty generator, zero-priced routes are NOT skipped.
    expect(block).toContain("inputPer1M: 0")
    expect(block).toContain("outputPer1M: 0")
    // 0/0 is NaN; a free model has no cache DISCOUNT to express.
    expect(block).not.toContain("cacheReadMultiplier")
  })

  it("skips a model with no published price at all", async () => {
    const files = await llmOpencodeGoGenerator.generate(fixtureCtx())
    expect(files[GO_OUTPUT]!).not.toContain("unpriced-preview")
  })

  it("backfills addedAt from release_date (already ISO — no unix conversion)", async () => {
    const files = await llmOpencodeGoGenerator.generate(fixtureCtx())
    expect(entryBlock(files[GO_OUTPUT]!, "opencode-go/glm-5.3")).toContain(
      'addedAt: "2026-08-14"',
    )
  })

  it("lists ONLY the Anthropic-surface ids (provider.npm discriminator), bare", async () => {
    const files = await llmOpencodeGoGenerator.generate(fixtureCtx())
    const src = files[GO_OUTPUT]!
    expect(src).toContain("export const OPENCODE_GO_ANTHROPIC_MODELS: readonly string[] = [")
    const list = src.slice(src.indexOf("OPENCODE_GO_ANTHROPIC_MODELS"))
    expect(list).toContain('"qwen3.8-flash"')
    // `@ai-sdk/openai` (Responses) and the bare chat/completions ids are NOT
    // reachable from an Anthropic client and must not appear.
    expect(list).not.toContain('"grok-4.5"')
    expect(list).not.toContain('"glm-5.3"')
  })

  it("ignores every other provider in the 213-provider payload", async () => {
    const files = await llmOpencodeGoGenerator.generate(fixtureCtx())
    expect(files[GO_OUTPUT]!).not.toContain("claude-opus-4-8")
    expect(files[GO_SNAPSHOT]!).not.toContain("claude-opus-4-8")
  })

  it("prunes the snapshot to its own provider slice, never the whole payload", async () => {
    const files = await llmOpencodeGoGenerator.generate(fixtureCtx())
    const snapshot = JSON.parse(files[GO_SNAPSHOT]!)
    expect(Object.keys(snapshot)).toEqual(["opencode-go"])
    // Same SHAPE as the source (nested provider.npm / cost), which is what
    // lets the generator re-read its own projection offline.
    expect(snapshot["opencode-go"].models["qwen3.8-flash"].provider.npm).toBe(
      "@ai-sdk/anthropic",
    )
    expect(snapshot["opencode-go"].models["glm-5.3"].cost.input).toBe(1.4)
  })

  it("re-projecting a projected snapshot is a no-op (round-trip stable)", async () => {
    const first = await llmOpencodeGoGenerator.generate(fixtureCtx())
    const projected = JSON.parse(first[GO_SNAPSHOT]!)
    const second = await llmOpencodeGoGenerator.generate({
      refresh: false,
      async fetchSource() {
        return projected
      },
    })
    expect(second[GO_SNAPSHOT]).toBe(first[GO_SNAPSHOT])
    expect(second[GO_OUTPUT]).toBe(first[GO_OUTPUT])
  })

  it("is byte-identical across two generate calls (deterministic)", async () => {
    const a = await llmOpencodeGoGenerator.generate(fixtureCtx())
    const b = await llmOpencodeGoGenerator.generate(fixtureCtx())
    expect(a).toEqual(b)
  })

  it("fails loud when the payload carries no such provider", async () => {
    await expect(
      llmOpencodeGoGenerator.generate({
        refresh: false,
        async fetchSource() {
          return { anthropic: FIXTURE.anthropic }
        },
      }),
    ).rejects.toThrow(/carries no "opencode-go" provider/)
  })

  it("declares the expected generator metadata", () => {
    expect(llmOpencodeGoGenerator.name).toBe("llm:opencode-go")
    expect(llmOpencodeGoGenerator.modality).toBe("llm")
    expect(llmOpencodeGoGenerator.sources[0]?.id).toBe("llm-opencode-go")
    expect(llmOpencodeGoGenerator.sources[0]?.url).toBe("https://models.dev/api.json")
    // Unauthenticated source: no headers means the runner never skips the
    // refresh for a missing env var.
    expect(llmOpencodeGoGenerator.sources[0]?.headers).toBeUndefined()
  })
})

describe("llm:opencode-zen generator — hand-written fixture", () => {
  it("emits its OWN files, keyed on the `opencode` provider", async () => {
    const files = await llmOpencodeZenGenerator.generate(fixtureCtx())
    expect(Object.keys(files).sort()).toEqual([ZEN_LEDGER, ZEN_OUTPUT, ZEN_SNAPSHOT].sort())
    expect(files[ZEN_OUTPUT]!).toContain(
      "export const OPENCODE_ZEN_ROUTES: Record<string, LLMPricing> = {",
    )
    expect(files[ZEN_OUTPUT]!).toContain('"opencode/claude-sonnet-5"')
  })

  it("prices Claude on Zen independently of direct Anthropic", async () => {
    const files = await llmOpencodeZenGenerator.generate(fixtureCtx())
    const block = entryBlock(files[ZEN_OUTPUT]!, "opencode/claude-sonnet-5")
    expect(block).toContain("inputPer1M: 2")
    expect(block).toContain("outputPer1M: 10")
    expect(block).toContain('vendor: "anthropic"')
    // The PROVIDER is the billing rail, the VENDOR is the builder.
    expect(block).toContain('provider: "opencode"')
  })

  it("counts a Gemini id as neither Anthropic-surface nor OpenAI-surface", async () => {
    const files = await llmOpencodeZenGenerator.generate(fixtureCtx())
    const list = files[ZEN_OUTPUT]!.slice(
      files[ZEN_OUTPUT]!.indexOf("OPENCODE_ZEN_ANTHROPIC_MODELS"),
    )
    expect(list).toContain('"claude-sonnet-5"')
    expect(list).not.toContain('"gemini-3-pro"')
  })

  it("declares the expected generator metadata", () => {
    expect(llmOpencodeZenGenerator.name).toBe("llm:opencode-zen")
    expect(llmOpencodeZenGenerator.sources[0]?.id).toBe("llm-opencode-zen")
    expect(llmOpencodeZenGenerator.sources[0]?.url).toBe("https://models.dev/api.json")
  })
})

describe("vendorForOpencodeModelId", () => {
  it("uses the repo's own vendor slugs, cross-checked against models.dev", () => {
    // Slugs match OPENROUTER_ROUTES' `vendor` values — hence `x-ai` not `xai`,
    // `moonshotai` not `moonshot`.
    expect(vendorForOpencodeModelId("glm-5.3")).toBe("z-ai")
    expect(vendorForOpencodeModelId("kimi-k3")).toBe("moonshotai")
    expect(vendorForOpencodeModelId("grok-4.6")).toBe("x-ai")
    expect(vendorForOpencodeModelId("claude-sonnet-5")).toBe("anthropic")
    expect(vendorForOpencodeModelId("gemini-3-pro")).toBe("google")
    expect(vendorForOpencodeModelId("gpt-6-astra")).toBe("openai")
    expect(vendorForOpencodeModelId("mimo-v2.5-pro")).toBe("xiaomi")
    expect(vendorForOpencodeModelId("hy4-preview")).toBe("tencent")
    expect(vendorForOpencodeModelId("longcat-2.0")).toBe("meituan")
    expect(vendorForOpencodeModelId("ling-3.0-flash-free")).toBe("inclusionai")
    expect(vendorForOpencodeModelId("ring-2.6-1t-free")).toBe("inclusionai")
    expect(vendorForOpencodeModelId("nemotron-3-ultra-free")).toBe("nvidia")
    expect(vendorForOpencodeModelId("trinity-large-preview-free")).toBe("arcee-ai")
    expect(vendorForOpencodeModelId("laguna-s-2.1-free")).toBe("poolside")
    expect(vendorForOpencodeModelId("north-mini-code-free")).toBe("cohere")
    expect(vendorForOpencodeModelId("muse-spark-1.3")).toBe("meta")
  })

  it("falls back to opencode for its own unattributed/stealth ids", () => {
    for (const id of ["omen-alpha", "ox-alpha-free", "big-pickle", "x-preview-f-free"]) {
      expect(vendorForOpencodeModelId(id)).toBe("opencode")
    }
  })
})

describe("llm:opencode-* generators — real committed snapshots (offline)", () => {
  it("emits the full OpenCode Go surface from its committed snapshot", async () => {
    const files = await llmOpencodeGoGenerator.generate(offlineCtx())
    const src = files[GO_OUTPUT]!
    expect(src).toContain('import type { LLMPricing } from "./catalog.js"')
    expect(src).toContain("export const OPENCODE_GO_ROUTES: Record<string, LLMPricing> = {")
    // The verified Go lineup: 36 models, 4 of them on the Anthropic surface.
    expect((src.match(/inputPer1M:/g) ?? []).length).toBe(36)
    const list = src.slice(src.indexOf("OPENCODE_GO_ANTHROPIC_MODELS"))
    expect([...list.matchAll(/^ {2}"([^"]+)",$/gm)].map(m => m[1])).toEqual([
      "minimax-m2.5",
      "minimax-m2.7",
      "minimax-m3",
      "qwen3.8-flash",
    ])
  })

  it("emits the full OpenCode Zen surface, whose Anthropic subset is the Claude family", async () => {
    const files = await llmOpencodeZenGenerator.generate(offlineCtx())
    const src = files[ZEN_OUTPUT]!
    // The verified Zen lineup: 102 models, 20 on the Anthropic surface.
    expect((src.match(/inputPer1M:/g) ?? []).length).toBe(102)
    const list = src.slice(src.indexOf("OPENCODE_ZEN_ANTHROPIC_MODELS"))
    const anthropicIds = [...list.matchAll(/^ {2}"([^"]+)",$/gm)].map(m => m[1])
    expect(anthropicIds).toHaveLength(20)
    for (const id of ["claude-opus-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-fable-5-1"]) {
      expect(anthropicIds).toContain(id)
    }
  })

  it("the committed snapshots are the PRUNED slices, not the 4.6 MB payload", async () => {
    for (const id of ["llm-opencode-go", "llm-opencode-zen"]) {
      const raw = await readFile(join(SNAPSHOTS_DIR, `${id}.json`), "utf8")
      // One provider key each; a whole-payload commit would carry 213.
      expect(Object.keys(JSON.parse(raw))).toHaveLength(1)
    }
  })

  it("generates the same bytes whether called directly or through the runner (write=false)", async () => {
    const go = await llmOpencodeGoGenerator.generate(offlineCtx())
    const zen = await llmOpencodeZenGenerator.generate(offlineCtx())
    const { files } = await runGenerators([llmOpencodeGoGenerator, llmOpencodeZenGenerator], {
      refresh: false,
      write: false,
    })
    for (const [path, content] of Object.entries({ ...go, ...zen })) {
      expect(files[path]).toBe(content)
    }
  })
})
