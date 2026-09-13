/**
 * Parity with `@agstudio/agent-framework`'s
 * `mastra/model-provider/model-routing.ts` — `defineRoutingPack` →
 * `definePack`, `overlayPack` → `overlay`, `resolveRoute` → `resolve`,
 * `RouteSource` → `Source`, `ModelRouteOrOff` → `RouteOrGate`.
 *
 * This was the implementation §2–§4 were extracted from, so the goal here is
 * closer to a straight port than a translation.
 *
 * NOT reconstructed, and why it doesn't need to be:
 *   - `resolveProviderForModel`'s catalog-based provider inference — out of
 *     scope by construction: §1 says `provider` omitted ⇒ inferred "by the
 *     host", and `resolve` never guesses it. A host still does this exactly
 *     as before, just entirely outside `resolve`.
 *   - `providerPinnedInId` — the original needed this because *its*
 *     `resolveRoute` always filled in `provider` (inferring it when absent),
 *     so callers needed a separate signal for "was this pinned or inferred".
 *     This package's `resolve` never infers, so the equivalent check is just
 *     `resolved.provider !== undefined` — see the test below. Simpler, not
 *     lossy.
 *   - `createModelForRole` / `RoleUnavailableError` / `createModel` — Mastra
 *     wiring, not a routing decision; reconstructed minimally below to show
 *     the gate signal it depends on (`resolve(...) === null`) is preserved.
 */
import { describe, expect, it } from "vitest"
import { envLayer, parseRouteRef } from "../env.js"
import { overlay, definePack } from "../pack.js"
import { resolve } from "../resolve.js"
import type { Layer, Route } from "../types.js"

type Role = "triage" | "speak" | "deepThink"

const KNOWN_PROVIDERS = ["openai", "anthropic", "google", "openrouter", "moonshot"]

const simone = definePack<Role>({
  id: "simone",
  label: "Simone",
  keyspace: "role",
  routes: {
    triage: { model: "claude-haiku-4-5-20251001", provider: "anthropic" },
    speak: { model: "kimi-k2.6" },
    // deepThink gated off on the free plan — the JSDoc example from the original file.
    deepThink: null,
  },
})

describe("parity: agent-framework model-routing.ts", () => {
  it("resolveRoute(pack, role, {}) === pack layer, unchanged", () => {
    expect(resolve(simone, "speak", [])).toEqual({ key: "speak", source: "pack", model: "kimi-k2.6" })
  })

  it("a role gated null throws-equivalent — RoleUnavailableError becomes resolve(...) === null", () => {
    class RoleUnavailableError extends Error {
      constructor(packId: string, role: string) {
        super(`Role "${role}" is declared unavailable in routing pack "${packId}".`)
      }
    }
    function createModelForRole(role: Role, layers: readonly Layer<Role>[] = []) {
      const resolved = resolve(simone, role, layers)
      if (!resolved) throw new RoleUnavailableError(simone.id, role)
      return resolved
    }
    expect(() => createModelForRole("deepThink")).toThrow(/declared unavailable/)
    expect(createModelForRole("speak").model).toBe("kimi-k2.6")
  })

  it("overrides array: multiple override sources checked in order, first match wins", () => {
    // Original: `overrides: [perUserOverride, perGuildOverride]`, each entry
    // either names the role or falls back to a "default" catch-all — checked
    // in array order, first hit wins. Two Layers, both source "override",
    // listed highest-precedence (per-user) first.
    const perUser: Layer<Role> = { source: "override", entries: {} } // user set nothing
    const perGuild: Layer<Role> = { source: "override", catchAll: { model: "gpt-4o" } }
    const resolved = resolve(simone, "speak", [perUser, perGuild])
    expect(resolved).toMatchObject({ model: "gpt-4o", source: "override" })
  })

  it("caller override beats env beats pack — full precedence stack", () => {
    const override: Layer<Role> = { source: "override", entries: { triage: { model: "o3-pro" } } }
    const env: Layer<Role> = { source: "env", entries: { triage: { model: "gpt-4o" } } }
    expect(resolve(simone, "triage", [override, env])).toMatchObject({ model: "o3-pro", source: "override" })
    expect(resolve(simone, "triage", [env])).toMatchObject({ model: "gpt-4o", source: "env" })
  })

  it("a catch-all (env's SIMONE_DEFAULT_MODEL) does not re-enable a pack-gated role", () => {
    const env = envLayer<Role>("SIMONE", ["triage", "speak", "deepThink"], {
      SIMONE_DEFAULT_MODEL: "gpt-4o-mini",
    })
    expect(resolve(simone, "speak", [env])).toMatchObject({ model: "gpt-4o-mini", source: "env" })
    expect(resolve(simone, "deepThink", [env])).toBeNull()
  })

  it("naming the role explicitly in env DOES re-enable it — SIMONE_DEEPTHINK_MODEL", () => {
    const env = envLayer<Role>(
      "SIMONE",
      ["triage", "speak", "deepThink"],
      {
        // envKeySuffix("deepThink") -> "DEEP_THINK", matching the original's envSuffix()
        SIMONE_DEEP_THINK_MODEL: "openrouter:anthropic/claude-3-5-sonnet-20241022",
        SIMONE_DEFAULT_MODEL: "gpt-4o-mini",
      },
      { knownProviders: KNOWN_PROVIDERS }
    )
    const resolved = resolve(simone, "deepThink", [env])
    expect(resolved).toMatchObject({ provider: "openrouter", model: "anthropic/claude-3-5-sonnet-20241022" })
  })

  it("provider:model env parsing scoped to known providers — parseRouteRef equivalence", () => {
    expect(parseRouteRef("openrouter:anthropic/claude-3-5-sonnet-20241022", KNOWN_PROVIDERS)).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-3-5-sonnet-20241022",
    })
    // "anthropic/claude-..." (an OpenRouter-shaped id with no *known* provider
    // prefix) is left whole, matching the original's guard against splitting
    // on an unrelated colon-free slash.
    expect(parseRouteRef("anthropic/claude-3-5-sonnet-20241022", KNOWN_PROVIDERS)).toEqual({
      model: "anthropic/claude-3-5-sonnet-20241022",
    })
  })

  it("providerPinnedInId is now just `resolved.provider !== undefined` — resolve never infers a provider", () => {
    const env = envLayer<Role>(
      "SIMONE",
      ["triage"],
      { SIMONE_TRIAGE_MODEL: "openrouter:gpt-4o" },
      { knownProviders: KNOWN_PROVIDERS }
    )
    const pinned = resolve(simone, "triage", [env])
    expect(pinned?.provider).toBe("openrouter") // explicitly pinned by the env layer

    const unpinned = resolve(simone, "speak", [])
    expect(unpinned?.provider).toBeUndefined() // pack never pinned one — host infers downstream, outside `resolve`
  })

  it("overlayPack: re-routing every role at once for a provider outage, without touching call sites", () => {
    const failover = overlay(simone, {
      id: "simone-openai-only",
      label: "Simone (Anthropic down)",
      routes: {
        triage: { model: "gpt-4o-mini", provider: "openai" },
        speak: { model: "gpt-4o", provider: "openai" },
        // deepThink stays gated — overlay only touches the keys it names
      },
    })
    expect(resolve(failover, "triage", [])).toMatchObject({ provider: "openai", model: "gpt-4o-mini" })
    expect(resolve(failover, "deepThink", [])).toBeNull()
  })

  it("fallbacks (§6 rungs) survive resolution untouched, distinct from chains", () => {
    const withFallback = definePack<"triage">({
      id: "x",
      label: "X",
      keyspace: "role",
      routes: {
        triage: {
          model: "o3-pro",
          provider: "openai",
          fallbacks: [{ model: "claude-haiku-4-5-20251001", provider: "anthropic" }],
        },
      },
    })
    const resolved = resolve(withFallback, "triage", [])
    expect(resolved?.fallbacks).toEqual([{ model: "claude-haiku-4-5-20251001", provider: "anthropic" }])
  })

  it("an env override for a role's fallback chain is expressible as a full Route in entries — no dedicated API needed", () => {
    // Original had a separate SIMONE_TRIAGE_FALLBACK env var, parsed
    // independently of the model override. Because a Layer's `entries` carry
    // a full Route (not a bare model string), the host can attach `fallbacks`
    // to that Route directly while building the env layer itself — no extra
    // primitive required.
    const rung: Route = { model: "claude-haiku-4-5-20251001", provider: "anthropic" }
    const env: Layer<Role> = {
      source: "env",
      entries: { triage: { model: "o3-pro", provider: "openai", fallbacks: [rung] } },
    }
    expect(resolve(simone, "triage", [env])?.fallbacks).toEqual([rung])
  })
})
