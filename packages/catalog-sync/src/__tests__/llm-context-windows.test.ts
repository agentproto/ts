import { describe, it, expect } from "vitest"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { llmContextWindowsGenerator } from "../generators/llm-context-windows.js"
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

const OUTPUT_PATH = "packages/model-catalog/src/llm/context-windows.generated.ts"

describe("llm:context-windows generator", () => {
  it("emits exactly one drop-in file at the model-catalog path", async () => {
    const files = await llmContextWindowsGenerator.generate(offlineCtx())
    expect(Object.keys(files)).toEqual([OUTPUT_PATH])
  })

  it("emits a parseable CONTEXT_WINDOWS map covering all four providers", async () => {
    const files = await llmContextWindowsGenerator.generate(offlineCtx())
    const src = files[OUTPUT_PATH]!
    expect(src).toBeTruthy()

    expect(src).toContain("export const CONTEXT_WINDOWS: Record<string, ContextWindowEntry> = {")

    // Entry count matches the committed snapshots exactly (deterministic).
    // NOTE: this number moves every time a provider adds or drops a model, so
    // it has to be bumped on each catalog sync — see the count-drift note on
    // the sync PR.
    const entryCount = (src.match(/contextWindow: \d+/g) ?? []).length
    expect(entryCount).toBe(49)

    // Spot-check one real entry per provider.
    expect(src).toContain('"claude-opus-4-8": { contextWindow: 1000000, maxOutput: 128000')
    expect(src).toContain('provider: "anthropic"')
    expect(src).toContain('"llama-3.3-70b-versatile": { contextWindow: 131072, maxOutput: 32768, provider: "groq" }')
    expect(src).toContain('"grok-4.5": { contextWindow: 500000, provider: "xai" }')
    expect(src).toContain('"kimi-k2.6": { contextWindow: 262144, provider: "moonshot" }')

    // xAI's null-context models (video) are excluded, not emitted as 0/null.
    expect(src).not.toContain("grok-imagine-video")
  })

  it("is byte-identical across two generate calls (deterministic)", async () => {
    const a = await llmContextWindowsGenerator.generate(offlineCtx())
    const b = await llmContextWindowsGenerator.generate(offlineCtx())
    expect(a).toEqual(b)
  })

  it("declares the expected generator metadata", () => {
    expect(llmContextWindowsGenerator.name).toBe("llm:context-windows")
    expect(llmContextWindowsGenerator.modality).toBe("llm")
    const ids = llmContextWindowsGenerator.sources.map(s => s.id)
    expect(ids).toEqual(["llm-anthropic", "llm-groq", "llm-xai", "llm-moonshot"])
  })

  it("generates the same bytes whether called directly or through the runner (write=false)", async () => {
    const direct = await llmContextWindowsGenerator.generate(offlineCtx())
    const { files } = await runGenerators([llmContextWindowsGenerator], {
      refresh: false,
      write: false,
    })
    expect(files).toEqual(direct)
  })
})
