import { describe, expect, it } from "vitest"

import type { SessionDescriptor } from "../client/types.js"
import type { SpawnAdapterInfo } from "./spawn.logic.js"
import { buildChangeModelPlaceHolder, makeChangeRouteItem, mapChangeModelQuickPickItems } from "./changeModel.logic.js"

function adapter(overrides: Partial<SpawnAdapterInfo> = {}): SpawnAdapterInfo {
  return { slug: "claude-code", ...overrides }
}

function session(
  overrides: Partial<Pick<SessionDescriptor, "model" | "mode" | "route">> = {},
): Pick<SessionDescriptor, "model" | "mode" | "route"> {
  return { ...overrides }
}

describe("mapChangeModelQuickPickItems", () => {
  it("groups models under a provider heading, one separator per provider", () => {
    const items = mapChangeModelQuickPickItems(
      adapter({
        modelDetails: [
          { id: "claude-sonnet-5", provider: "anthropic" },
          { id: "kimi-k2.7-code", provider: "moonshot", mode: "moonshot" },
        ],
      }),
      session({ model: "claude-sonnet-5" }),
    )
    expect(items.map(i => ({ label: i.label, kind: i.kind }))).toEqual([
      { label: "anthropic", kind: -1 },
      { label: "claude-sonnet-5", kind: undefined },
      { label: "moonshot", kind: -1 },
      { label: "kimi-k2.7-code", kind: undefined },
    ])
  })

  it("groups an unstated-provider model under the adapter's own name", () => {
    const items = mapChangeModelQuickPickItems(
      adapter({ slug: "codex", modelDetails: [{ id: "o4-mini" }] }),
      session(),
    )
    expect(items).toEqual([
      { label: "codex", kind: -1 },
      { label: "o4-mini", model: "o4-mini" },
    ])
  })

  it("marks the row matching the session's current model", () => {
    const items = mapChangeModelQuickPickItems(
      adapter({ modelDetails: [{ id: "opus-5", provider: "anthropic" }, { id: "sonnet-5", provider: "anthropic" }] }),
      session({ model: "sonnet-5" }),
    )
    const opus = items.find(i => i.model === "opus-5")
    const sonnet = items.find(i => i.model === "sonnet-5")
    expect(opus?.current).toBeUndefined()
    expect(opus?.description).toBeUndefined()
    expect(sonnet?.current).toBe(true)
    expect(sonnet?.description).toBe("current")
  })

  it("flags a row bound to a different mode than the session's own as restart-required", () => {
    const items = mapChangeModelQuickPickItems(
      adapter({
        modelDetails: [
          { id: "claude-sonnet-5", provider: "anthropic" }, // no mode — native
          { id: "kimi-k2.7-code", provider: "moonshot", mode: "moonshot" },
        ],
      }),
      session({ model: "claude-sonnet-5" }), // session.mode is undefined (native)
    )
    const native = items.find(i => i.model === "claude-sonnet-5")
    const gateway = items.find(i => i.model === "kimi-k2.7-code")
    expect(native?.restartRequired).toBeUndefined()
    expect(gateway?.restartRequired).toBe(true)
    expect(gateway?.description).toBe("restart required")
  })

  it("does NOT flag a gateway row bound to the SAME mode the session is already running", () => {
    const items = mapChangeModelQuickPickItems(
      adapter({
        modelDetails: [
          { id: "kimi-k2.7-code", provider: "moonshot", mode: "moonshot" },
          { id: "kimi-k2.7-fast", provider: "moonshot", mode: "moonshot" },
        ],
      }),
      session({ model: "kimi-k2.7-code", mode: "moonshot" }),
    )
    for (const item of items) {
      if (item.model) expect(item.restartRequired).toBeUndefined()
    }
  })

  it("flags EVERY row as restart-required when the adapter's modelApply is 'arg'", () => {
    const items = mapChangeModelQuickPickItems(
      adapter({
        slug: "codex",
        modelApply: "arg",
        modelDetails: [{ id: "o4-mini" }, { id: "o4" }],
      }),
      session({ model: "o4-mini" }),
    )
    const modelRows = items.filter(i => i.model !== undefined)
    expect(modelRows).toHaveLength(2)
    for (const row of modelRows) {
      expect(row.restartRequired).toBe(true)
      expect(row.description).toBe("restart required")
    }
    // Even the currently-active row is honestly marked restart-required —
    // the adapter can't apply ANY switch live, including "switch to itself".
    const current = modelRows.find(r => r.model === "o4-mini")
    expect(current?.current).toBe(true)
    expect(current?.restartRequired).toBe(true)
  })

  it("shows no extra route suffix for a bare or direct-route model ref", () => {
    const items = mapChangeModelQuickPickItems(
      adapter({
        modelDetails: [
          { id: "claude-sonnet-5", provider: "anthropic" },
          { id: "claude-opus-4-8" },
        ],
      }),
      session({ model: "claude-sonnet-5" }),
    )
    expect(items.find(i => i.model === "claude-sonnet-5")?.description).toBe("current")
    expect(items.find(i => i.model === "claude-opus-4-8")?.description).toBeUndefined()
  })

  it("appends the explicit route to a route-pinned model ref", () => {
    const items = mapChangeModelQuickPickItems(
      adapter({
        modelDetails: [
          { id: "z-ai/glm-5.2@openrouter", provider: "z-ai" },
          { id: "z-ai/glm-5.2@requesty", provider: "z-ai" },
        ],
      }),
      session({ model: "z-ai/glm-5.2@openrouter" }),
    )
    expect(items.find(i => i.model === "z-ai/glm-5.2@openrouter")?.description).toBe("current · via openrouter")
    const requesty = items.find(i => i.model === "z-ai/glm-5.2@requesty")
    expect(requesty?.restartRequired).toBe(true)
    expect(requesty?.description).toBe("restart required · via requesty")
  })

  it("does NOT flag a false restart-required when the session's route.gateway is stamped (hermes fix)", () => {
    // Regression for the hermes false-positive: a session running a bare
    // (no `@route` suffix) model that bills a gateway must carry that
    // gateway on `session.route.gateway` — the runtime now stamps it at
    // spawn time (session-spawn.ts) for by-model-router adapters. Once
    // it's present, switching to another model pinned to the SAME gateway
    // must not be flagged restart-required.
    const items = mapChangeModelQuickPickItems(
      adapter({
        slug: "hermes",
        modelDetails: [
          { id: "deepseek/deepseek-v3.2" },
          { id: "deepseek/deepseek-v4-flash-0731@openrouter" },
        ],
      }),
      session({ model: "deepseek/deepseek-v3.2", route: { gateway: "openrouter" } }),
    )
    const target = items.find(i => i.model === "deepseek/deepseek-v4-flash-0731@openrouter")
    expect(target?.restartRequired).toBeUndefined()
    // Still names the route (both rows bill the same one) — just no longer
    // prefixed with "restart required".
    expect(target?.description).toBe("via openrouter")
  })

  it("WOULD false-positive without the stamped gateway (documents the bug this fix closes)", () => {
    // Same rows as above, but the session descriptor lacks `route.gateway`
    // — the pre-fix shape. `resolveEffectiveRoute` falls back to the bare
    // model's own (wrong) direct-vendor assumption, so the picker flags an
    // unnecessary restart even though both rows bill `openrouter`.
    const items = mapChangeModelQuickPickItems(
      adapter({
        slug: "hermes",
        modelDetails: [
          { id: "deepseek/deepseek-v3.2" },
          { id: "deepseek/deepseek-v4-flash-0731@openrouter" },
        ],
      }),
      session({ model: "deepseek/deepseek-v3.2" }),
    )
    const target = items.find(i => i.model === "deepseek/deepseek-v4-flash-0731@openrouter")
    expect(target?.restartRequired).toBe(true)
  })

  it("merges restart-required and route suffix on a cross-route row", () => {
    const items = mapChangeModelQuickPickItems(
      adapter({
        modelDetails: [
          { id: "claude-sonnet-5", provider: "anthropic" },
          { id: "anthropic/claude-sonnet-5@openrouter", provider: "anthropic" },
        ],
      }),
      session({ model: "claude-sonnet-5" }),
    )
    const widened = items.find(i => i.model === "anthropic/claude-sonnet-5@openrouter")
    expect(widened?.restartRequired).toBe(true)
    expect(widened?.description).toBe("restart required · via openrouter")
  })

  it("prepends a synthetic 'Change route' row that opens the route chip picker", () => {
    const row = makeChangeRouteItem()
    expect(row.openRouteChip).toBe(true)
    expect(row.label).toMatch(/Change route/)
    expect(row.model).toBeUndefined()
    expect(row.description).toMatch(/gateway/)
  })

  it("returns an empty array when the adapter declares no models", () => {
    expect(mapChangeModelQuickPickItems(adapter({ modelDetails: [] }), session())).toEqual([])
  })

  it("falls back to the flat `models` list when modelDetails is absent (older daemon)", () => {
    const items = mapChangeModelQuickPickItems(
      adapter({ models: ["opus-5", "sonnet-5"] }),
      session({ model: "opus-5" }),
    )
    expect(items.map(i => i.label)).toEqual(["claude-code", "opus-5", "sonnet-5"])
    expect(items.find(i => i.model === "opus-5")?.current).toBe(true)
  })
})

describe("buildChangeModelPlaceHolder", () => {
  it("names the session's current model", () => {
    expect(buildChangeModelPlaceHolder({ adapterSlug: "hermes", model: "kimi-k2.7-code" })).toBe(
      "Switch model for hermes (currently kimi-k2.7-code)",
    )
  })

  it("says so when no model is recorded", () => {
    expect(buildChangeModelPlaceHolder({ adapterSlug: "codex" })).toBe(
      "Switch model for codex (no model recorded)",
    )
  })
})
