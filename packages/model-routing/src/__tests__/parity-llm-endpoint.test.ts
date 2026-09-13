/**
 * Parity with `packages/llm-endpoint/src/packs.ts`'s `ModelPack` / `ModelRoute`
 * / `PACK_REGISTRY` — reconstructs its real registry shape on this package's
 * API and proves the resolution it depends on is equivalent.
 *
 * NOT reconstructed here, because it is genuinely out of AIP-57's scope (the
 * spec's own Rationale: transforms like these are AIP-51 `Processor`s, not
 * this primitive) — see the PR description for the full list:
 *   - `toolsExclude` / `toolsAllow` tool-name trimming
 *   - `toAnthropicStyle` / `shaNumericId` / `TIER_TO_FAMILY` Claude-alias generation
 *   - local-pack JSON schema validation (`validateModelPack` et al.)
 *   - `KNOWN_TRANSPARENT_PROVIDERS` / `parseTransparentModel` client-facing parsing
 */
import { describe, expect, it } from "vitest"
import { definePack } from "../pack.js"
import { resolve } from "../resolve.js"
import type { Pack, Route } from "../types.js"

// packs.ts's ModelRoute carries verified-capability fields beyond the AIP-57
// base Route — exactly the extension point §1 calls out ("Implementations
// MAY carry verified capability metadata alongside a Route"). Expressed here
// as a Route subtype threaded through the pack's generic R parameter.
interface LlmEndpointRoute extends Route {
  contextWindow?: number
  maxOutputTokens?: number
}

const anthropicPack = definePack<
  "claude-opus-4-8" | "claude-sonnet-5" | "claude-haiku-4-5" | "claude-fable-5",
  LlmEndpointRoute
>({
  id: "anthropic",
  label: "Anthropic (direct)",
  keyspace: "model",
  routes: {
    "claude-opus-4-8": { provider: "anthropic", model: "claude-opus-4-8" },
    "claude-sonnet-5": { provider: "anthropic", model: "claude-sonnet-5" },
    // Anthropic's live /v1/models does not expose a bare "claude-haiku-4-5" —
    // only the datestamped id resolves. Same code/model split as the original.
    "claude-haiku-4-5": { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
    "claude-fable-5": { provider: "anthropic", model: "claude-fable-5", contextWindow: 200000 },
  },
})

const xaiPack = definePack<"grok-4.5" | "grok-4.3", LlmEndpointRoute>({
  id: "xai",
  label: "xAI (Grok)",
  keyspace: "model",
  routes: {
    "grok-4.5": { provider: "xai", model: "grok-4.5" },
    "grok-4.3": { provider: "xai", model: "grok-4.3" },
  },
})

// PACK_REGISTRY was a plain `Record<string, ModelPack>` — nothing in AIP-57's
// four primitives needs to own that; a registry-of-packs is just host-level
// indexing, so this is exactly what a consumer writes, unassisted. Widened to
// `Pack<string, LlmEndpointRoute>` because a registry mixes packs whose
// keyspaces (the literal model codes) legitimately differ pack to pack.
const PACK_REGISTRY: Record<string, Pack<string, LlmEndpointRoute>> = {
  [anthropicPack.id]: anthropicPack,
  [xaiPack.id]: xaiPack,
}
const DEFAULT_PACK_ID = "anthropic"

/** Mirrors `resolvePack` from packs.ts — a 3-line host lookup, not a library primitive. */
function resolvePack(packId: string | null | undefined): Pack<string, LlmEndpointRoute> {
  const id = packId ?? DEFAULT_PACK_ID
  const pack = PACK_REGISTRY[id]
  if (!pack) throw new RangeError(`Unknown pack id: "${id}". Available: ${Object.keys(PACK_REGISTRY).join(", ")}`)
  return pack
}

describe("parity: llm-endpoint packs.ts", () => {
  it("resolves a code to its route the same way buildMappingFromPack + direct lookup did", () => {
    const pack = resolvePack("anthropic")
    const resolved = resolve(pack, "claude-haiku-4-5", [])
    expect(resolved).toMatchObject({ provider: "anthropic", model: "claude-haiku-4-5-20251001" })
  })

  it("carries verified contextWindow/maxOutputTokens through resolution, absent when unverified", () => {
    const pack = resolvePack("anthropic")
    expect(resolve(pack, "claude-fable-5", [])).toMatchObject({ contextWindow: 200000 })
    const opus = resolve(pack, "claude-opus-4-8", [])
    expect(opus).not.toHaveProperty("contextWindow")
  })

  it("resolvePack(undefined) falls back to the default pack, matching the original null/undefined handling", () => {
    expect(resolvePack(undefined).id).toBe(DEFAULT_PACK_ID)
    expect(resolvePack(null).id).toBe(DEFAULT_PACK_ID)
  })

  it("an unknown pack id throws, matching the original RangeError contract", () => {
    expect(() => resolvePack("does-not-exist")).toThrow(RangeError)
  })

  it("selecting a different pack (llm-endpoint's real re-routing lever) changes every route in one step", () => {
    expect(resolve(resolvePack("xai"), "grok-4.5", [])).toMatchObject({ provider: "xai", model: "grok-4.5" })
  })
})
