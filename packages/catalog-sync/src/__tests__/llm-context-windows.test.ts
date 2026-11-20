import { describe, it, expect } from "vitest"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { GOOGLE_NATIVE_MODEL_IDS } from "../generators/google-native-model-ids.mjs"
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

    // Bare "latest" ids mechanically derived from their dated siblings
    // (claude-opus-4-6 incident, then repeated for context windows — see
    // the derivation comment in the generator). Anthropic's live /v1/models
    // only lists the dated form for an aged-out generation; the bare form
    // must still resolve so it stays in listNativeModelIds and every
    // adapter's native model menu.
    expect(src).toContain('"claude-haiku-4-5": { contextWindow: 200000, maxOutput: 64000')
    expect(src).toContain('"claude-opus-4-5": { contextWindow: 200000, maxOutput: 64000')
    expect(src).toContain('"claude-sonnet-4-5": { contextWindow: 200000, maxOutput: 64000')

    // Spot-check one real entry per provider.
    expect(src).toContain('"claude-opus-4-8": { contextWindow: 1000000, maxOutput: 128000')
    expect(src).toContain('provider: "anthropic"')
    expect(src).toContain('"llama-3.3-70b-versatile": { contextWindow: 131072, maxOutput: 32768, provider: "groq" }')
    expect(src).toContain('"grok-4.5": { contextWindow: 500000, provider: "xai" }')
    expect(src).toContain('"kimi-k2.6": { contextWindow: 262144, provider: "moonshot" }')
    expect(src).toContain('"codestral-2508": { contextWindow: 256000, provider: "mistral" }')
    // Google — sourced from OpenRouter, remapped to bare native ids. Which
    // ids are confirmed is data (GOOGLE_NATIVE_MODEL_IDS, extended on every
    // Google release), so no id is named here: see the allow-list test below.

    // xAI's null-context models (video) are excluded, not emitted as 0/null.
    expect(src).not.toContain("grok-imagine-video")

    // Mistral's `name` field is an alias pointer, not a display name — never
    // surfaced as `displayName` for mistral entries.
    expect(src).not.toContain('"mistral-code-latest": { contextWindow: 256000, displayName:')

  })

  it("emits Google entries only for the confirmed native allow-list, nothing guessed", async () => {
    const files = await llmContextWindowsGenerator.generate(offlineCtx())
    const src = files[OUTPUT_PATH]!
    const emitted = [...src.matchAll(/^\s+"([^"]+)": \{[^}]*provider: "google"/gm)].map(m => m[1]!)
    expect(emitted.length).toBeGreaterThan(0)
    // Every emitted Google id is allow-listed (batch routes, image/preview
    // variants, other families and unconfirmed lines are skipped)...
    for (const id of emitted) expect(GOOGLE_NATIVE_MODEL_IDS.has(id), id).toBe(true)
    // ...and the generator drops the Google routes of the snapshot that are
    // NOT allow-listed, so the assertion above is not vacuous.
    const snapshot = JSON.parse(await readFile(join(SNAPSHOTS_DIR, "llm-openrouter.json"), "utf8")) as {
      data: Array<{ id: string }>
    }
    const googleRoutes = snapshot.data.map(m => m.id).filter(id => id.startsWith("google/"))
    const notAllowed = googleRoutes.filter(id => !GOOGLE_NATIVE_MODEL_IDS.has(id.slice("google/".length)))
    expect(notAllowed.length).toBeGreaterThan(0)
    for (const id of notAllowed) expect(emitted).not.toContain(id.slice("google/".length))
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
