import { describe, it, expect } from "vitest"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { llmOpenRouterGenerator } from "../generators/llm-openrouter.js"
import { runGenerators } from "../runner.js"
import type { GeneratorContext } from "../types.js"

const HERE = dirname(fileURLToPath(import.meta.url))
// packages/catalog-sync/src/__tests__/ → packages/catalog-sync/snapshots/
const SNAPSHOTS_DIR = join(HERE, "..", "..", "snapshots")

/**
 * OFFLINE context — reads the committed snapshot from disk. NEVER hits the
 * network (refresh=false + a committed snapshot is the contract). If the
 * snapshot is missing this throws, which is the correct test-env failure.
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

const OUTPUT_PATH = "packages/model-catalog/src/llm/openrouter-routes.generated.ts"

describe("llm:openrouter generator", () => {
  it("emits exactly one drop-in file at the model-catalog path", async () => {
    const files = await llmOpenRouterGenerator.generate(offlineCtx())
    expect(Object.keys(files)).toEqual([OUTPUT_PATH])
  })

  it("emits a parseable OPENROUTER_ROUTES map with ≥1 entry", async () => {
    const files = await llmOpenRouterGenerator.generate(offlineCtx())
    const src = files[OUTPUT_PATH]!
    expect(src).toBeTruthy()

    // Structural anchors mirroring the committed drop-in shape.
    expect(src).toContain('import type { LLMPricing } from "./catalog.js"')
    expect(src).toContain("export const OPENROUTER_ROUTES: Record<string, LLMPricing> = {")
    expect(src).toContain("export const OPENROUTER_PROVIDERS: readonly string[] = [")

    // Entry count = number of `inputPer1M:` occurrences. Matches the 6-model
    // committed snapshot exactly (deterministic from the fixture); ≥1 is the
    // contract floor.
    const entryCount = (src.match(/inputPer1M:/g) ?? []).length
    expect(entryCount).toBe(6)
    expect(entryCount).toBeGreaterThanOrEqual(1)

    // Spot-check a real entry WITH cache fields (Anthropic prompt caching).
    expect(src).toContain('"anthropic/claude-haiku-4.5":')
    expect(src).toContain("cacheReadMultiplier: 0.1")
    expect(src).toContain("cacheWriteMultiplier: 1.25")
    // And one WITHOUT cache fields (DeepSeek — no cache_read/cache_write).
    expect(src).toContain('"deepseek/deepseek-chat":')

    // Providers list: derived + sorted + deduped.
    expect(src).toContain('"anthropic",')
    expect(src).toContain('"openai",')
    // z-ai is NOT in the 6-model fixture.
    expect(src).not.toContain('"z-ai"')
  })

  it("is byte-identical across two generate calls (deterministic)", async () => {
    const a = await llmOpenRouterGenerator.generate(offlineCtx())
    const b = await llmOpenRouterGenerator.generate(offlineCtx())
    expect(a).toEqual(b)
  })

  it("declares the expected generator metadata", () => {
    expect(llmOpenRouterGenerator.name).toBe("llm:openrouter")
    expect(llmOpenRouterGenerator.modality).toBe("llm")
    expect(llmOpenRouterGenerator.sources[0]?.id).toBe("llm-openrouter")
    expect(llmOpenRouterGenerator.sources[0]?.url).toBe(
      "https://openrouter.ai/api/v1/models"
    )
  })

  it("generates the same bytes whether called directly or through the runner (write=false)", async () => {
    const direct = await llmOpenRouterGenerator.generate(offlineCtx())
    const { files } = await runGenerators([llmOpenRouterGenerator], {
      refresh: false,
      write: false,
    })
    expect(files).toEqual(direct)
  })
})
