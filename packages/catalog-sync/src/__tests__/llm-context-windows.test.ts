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

  it("emits a parseable CONTEXT_WINDOWS map covering all six providers", async () => {
    const files = await llmContextWindowsGenerator.generate(offlineCtx())
    const src = files[OUTPUT_PATH]!
    expect(src).toBeTruthy()

    expect(src).toContain("export const CONTEXT_WINDOWS: Record<string, ContextWindowEntry> = {")

    // Floor, not exact equality. An exact-equality assertion on a count that
    // moves every time a provider adds or drops a model turns every routine
    // catalog sync into a required manual bump — PR #1082 (a fully automated
    // sync PR) permanently red-built on exactly this: its snapshot updates
    // dropped the real count to 104 while this assertion still demanded 112,
    // and nothing in that PR's own diff touches this test, so it had no way
    // to self-heal. A floor still catches what this assertion actually
    // guards against — the generator silently losing most/all of a
    // provider's models — while tolerating normal single-digit sync drift.
    const entryCount = (src.match(/contextWindow: \d+/g) ?? []).length
    expect(entryCount).toBeGreaterThanOrEqual(100)

    // Spot-check one real entry per provider.
    expect(src).toContain('"claude-opus-4-8": { contextWindow: 1000000, maxOutput: 128000')
    expect(src).toContain('provider: "anthropic"')
    expect(src).toContain('"llama-3.3-70b-versatile": { contextWindow: 131072, maxOutput: 32768, provider: "groq" }')
    expect(src).toContain('"grok-4.5": { contextWindow: 500000, provider: "xai" }')
    expect(src).toContain('"kimi-k2.6": { contextWindow: 262144, provider: "moonshot" }')
    expect(src).toContain('"codestral-2508": { contextWindow: 256000, provider: "mistral" }')
    // Google — sourced from OpenRouter, remapped from `google/gemini-2.5-pro`
    // to the bare native id, with maxOutput from `top_provider.max_completion_tokens`.
    expect(src).toContain('"gemini-2.5-pro": { contextWindow: 1048576, maxOutput: 65536, provider: "google" }')

    // xAI's null-context models (video) are excluded, not emitted as 0/null.
    expect(src).not.toContain("grok-imagine-video")

    // Mistral's `name` field is an alias pointer, not a display name — never
    // surfaced as `displayName` for mistral entries.
    expect(src).not.toContain('"mistral-code-latest": { contextWindow: 256000, displayName:')

    // Google — only the 7 confirmed native ids are emitted. Batch routes,
    // image/preview/customtools variants, non-Gemini families, and newer
    // unconfirmed Gemini lines are all skipped, not guessed.
    expect(src).not.toContain('"gemini-2.5-pro:batch"')
    expect(src).not.toContain('"gemini-3-pro-image"')
    expect(src).not.toContain('"gemini-2.5-pro-preview"')
    expect(src).not.toContain('"gemini-3.1-pro-preview-customtools"')
    expect(src).not.toContain('"gemma-3-27b-it"')
    expect(src).not.toContain('"lyria-3-pro-preview"')
    expect(src).not.toContain('"gemini-3.6-flash"')
    expect(src).not.toContain('"gemini-3.7-flash"')
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
    expect(ids).toEqual([
      "llm-anthropic",
      "llm-groq",
      "llm-xai",
      "llm-moonshot",
      "llm-mistral",
      "llm-openrouter",
    ])
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
