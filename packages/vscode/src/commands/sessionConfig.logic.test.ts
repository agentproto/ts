import { describe, expect, it } from "vitest"

import type { SessionDescriptor } from "../client/types.js"
import type { SpawnAdapterInfo } from "./spawn.logic.js"
import {
  buildSessionActions,
  buildSessionConfigChips,
  canonicalForModeId,
  currentRouteOf,
  RESTART_AFFIX,
  resolveAccessRows,
  resolveCapabilities,
  resolveEfforts,
  resolvePostureRows,
  resolveRouteRows,
  type CapabilityResolutionInput,
  type CatalogModelsResult,
} from "./sessionConfig.logic.js"

function adapter(overrides: Partial<SpawnAdapterInfo> = {}): SpawnAdapterInfo {
  return { slug: "claude-code", ...overrides }
}

type PickerDescriptor = Pick<
  SessionDescriptor,
  "model" | "mode" | "effort" | "posture" | "route" | "contextProfile" | "accessProfile" | "busy"
>

function descriptor(overrides: Partial<PickerDescriptor> = {}): PickerDescriptor {
  return { ...overrides }
}

/** A minimal catalog: one anthropic product on two routes (direct + moonshot). */
function catalog(overrides?: Partial<CatalogModelsResult>): CatalogModelsResult {
  return (
    overrides?.vendors
      ? (overrides as CatalogModelsResult)
      : {
          vendors: [
            {
              vendor: "anthropic",
              products: [
                {
                  product: "claude-opus-4-8",
                  routes: [
                    {
                      route: "anthropic",
                      ref: "anthropic/claude-opus-4-8",
                      baseUrl: null,
                      runnable: true,
                      eligibleProfiles: ["jeremy-max", "work-anthropic-key"],
                      adapterModes: [],
                      curated: true,
                    },
                    {
                      route: "moonshot",
                      ref: "anthropic/claude-opus-4-8@moonshot",
                      baseUrl: "https://api.moonshot.ai/anthropic",
                      runnable: false,
                      eligibleProfiles: [],
                      adapterModes: ["moonshot"],
                      curated: false,
                    },
                  ],
                },
              ],
            },
          ],
        }
  )
}

/** A router catalog: one product reachable via openrouter or requesty. */
function routerCatalog(): CatalogModelsResult {
  return {
    vendors: [
      {
        vendor: "z-ai",
        products: [
          {
            product: "glm-5.2",
            routes: [
              {
                route: "openrouter",
                ref: "z-ai/glm-5.2@openrouter",
                baseUrl: "https://openrouter.ai",
                runnable: true,
                eligibleProfiles: ["or-key"],
                adapterModes: [],
                curated: true,
              },
              {
                route: "requesty",
                ref: "z-ai/glm-5.2@requesty",
                baseUrl: "https://requesty.ai",
                runnable: true,
                eligibleProfiles: ["requesty-key"],
                adapterModes: [],
                curated: false,
              },
            ],
          },
        ],
      },
    ],
  }
}

const baseInput = (overrides: Partial<CapabilityResolutionInput> = {}): CapabilityResolutionInput => ({
  adapter: adapter(),
  model: "claude-opus-4-8",
  ...overrides,
})

describe("resolveEfforts — model-dependent, re-resolves on model change", () => {
  const efforts = {
    "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max", "ultracode"],
    "claude-haiku-4-5": ["low", "medium", "high"],
  } as const

  it("opus offers ultracode; haiku does not (same adapter, different model)", () => {
    const opus = resolveEfforts(baseInput({ model: "claude-opus-4-8", effortsByModel: efforts }))
    const haiku = resolveEfforts(baseInput({ model: "claude-haiku-4-5", effortsByModel: efforts }))
    expect(opus).toContain("ultracode")
    expect(haiku).not.toContain("ultracode")
    expect(haiku).toEqual(["low", "medium", "high"])
  })

  it("falls back to defaultEfforts for a model with no advertised set", () => {
    expect(
      resolveEfforts(baseInput({ model: "unknown", effortsByModel: efforts, defaultEfforts: ["medium"] })),
    ).toEqual(["medium"])
  })

  it("resolves empty (⇒ chip hidden) when nothing is advertised and no fallback", () => {
    expect(resolveEfforts(baseInput({ model: "unknown", effortsByModel: efforts }))).toEqual([])
  })
})

describe("resolvePostureRows — native vs advisory labeling (SPEC Rw)", () => {
  it("labels an advertised native mode 'enforced' and sends the canonical value", () => {
    const rows = resolvePostureRows([{ id: "plan", name: "Plan" }])
    const plan = rows.find(r => r.value === "plan")
    expect(plan?.enforcement).toBe("enforced")
    expect(plan?.label).toBe("plan (enforced)")
    expect(plan?.restartRequired).toBe(false)
  })

  it("labels a canonical posture with no native mode 'advisory' + restart-tagged", () => {
    // A harness advertising ONLY plan: the other canonical postures are advisory.
    const rows = resolvePostureRows([{ id: "plan", name: "Plan" }])
    const bypass = rows.find(r => r.value === "bypass")
    expect(bypass?.enforcement).toBe("advisory")
    expect(bypass?.label).toBe("bypass (advisory)")
    expect(bypass?.restartRequired).toBe(true)
    // Never presented as a real permission boundary.
    expect(bypass?.description).toMatch(/advisory/)
  })

  it("does NOT double a canonical posture the harness advertises natively", () => {
    // claude-code's ACP wrapper spells accept-edits as `acceptEdits`.
    const rows = resolvePostureRows([{ id: "acceptEdits", name: "Accept Edits" }])
    const acceptRows = rows.filter(r => r.value === "accept-edits")
    expect(acceptRows).toHaveLength(1)
    expect(acceptRows[0]?.enforcement).toBe("enforced")
    expect(canonicalForModeId("acceptEdits")).toBe("accept-edits")
  })

  it("a harness with NO modes (hermes) still gets every canonical posture, all advisory", () => {
    const rows = resolvePostureRows([])
    expect(rows.every(r => r.enforcement === "advisory")).toBe(true)
    expect(rows.map(r => r.value).sort()).toEqual(
      ["accept-edits", "bypass", "default", "plan", "read-only"].sort(),
    )
  })

  it("keeps a native harness mode with no canonical name as its raw id", () => {
    const rows = resolvePostureRows([{ id: "architect", name: "Architect" }])
    const architect = rows.find(r => r.value === "architect")
    expect(architect?.enforcement).toBe("enforced")
    expect(architect?.label).toBe("Architect (enforced)")
  })
})

describe("resolveRouteRows / currentRouteOf — catalog-derived, non-runnable flagged", () => {
  it("lists a model's routes from the catalog", () => {
    const rows = resolveRouteRows(catalog(), "claude-opus-4-8")
    expect(rows.map(r => r.value)).toEqual(["anthropic", "moonshot"])
  })

  it("names the gap on a runnable:false route (no eligible profile)", () => {
    const rows = resolveRouteRows(catalog(), "claude-opus-4-8")
    const moonshot = rows.find(r => r.value === "moonshot")
    expect(moonshot?.runnable).toBe(false)
    expect(moonshot?.description).toBe("no eligible anthropic profile — add one")
  })

  it("resolves the DIRECT route when the descriptor names no gateway", () => {
    const current = currentRouteOf({ model: "claude-opus-4-8" }, catalog())
    expect(current?.value).toBe("anthropic")
    expect(current?.baseUrl).toBeNull()
  })

  it("resolves the explicit gateway when set", () => {
    const current = currentRouteOf(
      { model: "claude-opus-4-8", route: { gateway: "moonshot" } },
      catalog(),
    )
    expect(current?.value).toBe("moonshot")
  })

  it("prefers the model ref's own pinned @route over a stale route.gateway", () => {
    const current = currentRouteOf(
      { model: "z-ai/glm-5.2@openrouter", route: { gateway: "requesty" } },
      routerCatalog(),
    )
    expect(current?.value).toBe("openrouter")
  })

  it("falls back to route.gateway when the model ref carries no @route suffix", () => {
    const current = currentRouteOf(
      { model: "z-ai/glm-5.2", route: { gateway: "requesty" } },
      routerCatalog(),
    )
    expect(current?.value).toBe("requesty")
  })

  it("lets route.gateway override the vendor-implied route for a parseable model without @route", () => {
    const anthropicCatalog: CatalogModelsResult = {
      vendors: [
        {
          vendor: "anthropic",
          products: [
            {
              product: "claude-sonnet-5",
              routes: [
                {
                  route: "anthropic",
                  ref: "anthropic/claude-sonnet-5",
                  baseUrl: null,
                  runnable: true,
                  eligibleProfiles: ["jeremy-max"],
                  adapterModes: [],
                  curated: true,
                },
                {
                  route: "moonshot",
                  ref: "anthropic/claude-sonnet-5@moonshot",
                  baseUrl: "https://api.moonshot.ai/anthropic",
                  runnable: true,
                  eligibleProfiles: ["moonshot-key"],
                  adapterModes: ["moonshot"],
                  curated: false,
                },
              ],
            },
          ],
        },
      ],
    }
    const current = currentRouteOf(
      { model: "anthropic/claude-sonnet-5", route: { gateway: "moonshot" } },
      anthropicCatalog,
    )
    expect(current?.value).toBe("moonshot")
  })

  it("returns empty for a model the catalog doesn't know (⇒ chip hidden)", () => {
    expect(resolveRouteRows(catalog(), "mystery-model")).toEqual([])
    expect(resolveRouteRows(undefined, "claude-opus-4-8")).toEqual([])
  })
})

describe("resolveAccessRows — eligibility + ineligible-profile re-pick (SPEC Rx)", () => {
  const profiles = [
    { id: "jeremy-max", endpoint: "anthropic", method: "oauth-bearer" as const, label: "Jeremy Max" },
    { id: "work-anthropic-key", endpoint: "anthropic", method: "api-key" as const, label: "Work key" },
    { id: "work-moonshot", endpoint: "moonshot", method: "api-key" as const, label: "Moonshot" },
  ]

  it("lists only the profiles eligible for the current route + a '+ add profile' row", () => {
    const direct = currentRouteOf({ model: "claude-opus-4-8" }, catalog())
    const { rows } = resolveAccessRows({ currentRoute: direct, profiles })
    expect(rows.filter(r => !r.addProfile).map(r => r.value)).toEqual([
      "jeremy-max",
      "work-anthropic-key",
    ])
    expect(rows.at(-1)?.addProfile).toBe(true)
  })

  it("flags an attached profile that is no longer eligible after a route change (Rx)", () => {
    // Session was on the anthropic sub (jeremy-max); user switches to moonshot,
    // where the Claude-Max profile is no longer eligible (empty eligibleProfiles).
    const moonshot = currentRouteOf(
      { model: "claude-opus-4-8", route: { gateway: "moonshot" } },
      catalog(),
    )
    const { rows, ineligibleAttached } = resolveAccessRows({
      currentRoute: moonshot,
      profiles,
      attachedProfileRef: "jeremy-max",
    })
    expect(ineligibleAttached).toBe("jeremy-max")
    // No eligible profile → only the add-profile row remains (never a stale wallet).
    expect(rows).toHaveLength(1)
    expect(rows[0]?.addProfile).toBe(true)
  })

  it("does NOT flag an attached profile that is still eligible", () => {
    const direct = currentRouteOf({ model: "claude-opus-4-8" }, catalog())
    const { ineligibleAttached } = resolveAccessRows({
      currentRoute: direct,
      profiles,
      attachedProfileRef: "jeremy-max",
    })
    expect(ineligibleAttached).toBeUndefined()
  })

  it("ignores a stale route.gateway when the model ref pins a different @route", () => {
    const routerProfiles = [
      { id: "or-key", endpoint: "openrouter", method: "api-key" as const, label: "OpenRouter" },
      { id: "requesty-key", endpoint: "requesty", method: "api-key" as const, label: "Requesty" },
    ]
    const current = currentRouteOf(
      { model: "z-ai/glm-5.2@openrouter", route: { gateway: "requesty" } },
      routerCatalog(),
    )
    const { rows, ineligibleAttached } = resolveAccessRows({
      currentRoute: current,
      profiles: routerProfiles,
      attachedProfileRef: "or-key",
    })
    expect(rows.filter(r => !r.addProfile).map(r => r.value)).toEqual(["or-key"])
    expect(ineligibleAttached).toBeUndefined()
  })
})

describe("resolveCapabilities — the §3.9 bundle re-resolves per model", () => {
  it("effort set changes with the model argument (opus↔haiku)", () => {
    const effortsByModel = {
      "claude-opus-4-8": ["low", "high", "ultracode"],
      "claude-haiku-4-5": ["low", "high"],
    } as const
    const opus = resolveCapabilities({ model: "claude-opus-4-8" }, baseInput({ model: "claude-opus-4-8", effortsByModel, catalog: catalog() }))
    const haiku = resolveCapabilities({ model: "claude-haiku-4-5" }, baseInput({ model: "claude-haiku-4-5", effortsByModel, catalog: catalog() }))
    expect(opus.efforts).toContain("ultracode")
    expect(haiku.efforts).not.toContain("ultracode")
  })

  it("methods reflect the eligible profiles for the current route", () => {
    const profiles = [
      { id: "jeremy-max", endpoint: "anthropic", method: "oauth-bearer" as const },
      { id: "work-anthropic-key", endpoint: "anthropic", method: "api-key" as const },
    ]
    const caps = resolveCapabilities(
      { model: "claude-opus-4-8" },
      baseInput({ catalog: catalog(), profiles }),
    )
    expect(caps.methods.sort()).toEqual(["api-key", "oauth-bearer"])
  })
})

describe("buildSessionConfigChips — dynamic set, empty capability ⇒ hidden", () => {
  const fullInput = () =>
    baseInput({
      adapter: adapter({
        modelDetails: [
          { id: "claude-opus-4-8", provider: "anthropic" },
          { id: "kimi-k2.7-code", provider: "moonshot", mode: "moonshot" },
        ],
      }),
      model: "claude-opus-4-8",
      effortsByModel: { "claude-opus-4-8": ["low", "high", "ultracode"] },
      availableModes: [{ id: "plan", name: "Plan" }],
      catalog: catalog(),
      profiles: [{ id: "jeremy-max", endpoint: "anthropic", method: "oauth-bearer" as const }],
      contextProfiles: ["full", "lean"],
    })

  it("emits every axis that has options, in SPEC order", () => {
    const chips = buildSessionConfigChips(descriptor({ model: "claude-opus-4-8" }), fullInput())
    expect(chips.map(c => c.axis)).toEqual([
      "model",
      "effort",
      "route",
      "access",
      "posture",
      "contextProfile",
    ])
  })

  it("HIDES a chip whose resolved option-set is empty (effort, route, contextProfile)", () => {
    const chips = buildSessionConfigChips(
      descriptor({ model: "mystery" }),
      baseInput({
        model: "mystery", // no efforts, no catalog routes for it
        adapter: adapter({ modelDetails: [{ id: "mystery" }] }),
        availableModes: [{ id: "plan", name: "Plan" }],
        // no effortsByModel/defaultEfforts, no catalog, no contextProfiles
      }),
    )
    const axes = chips.map(c => c.axis)
    expect(axes).not.toContain("effort")
    expect(axes).not.toContain("route")
    expect(axes).not.toContain("contextProfile")
    // model + posture + access still present (access always offers add-profile).
    expect(axes).toContain("model")
    expect(axes).toContain("posture")
    expect(axes).toContain("access")
  })

  it("binds each chip to exactly one daemon verb (SPEC §4.5)", () => {
    const chips = buildSessionConfigChips(descriptor({ model: "claude-opus-4-8" }), fullInput())
    const verbFor = (axis: string) => chips.find(c => c.axis === axis)?.verb
    expect(verbFor("model")).toBe("agent_set_model")
    expect(verbFor("effort")).toBe("agent_set_effort")
    expect(verbFor("posture")).toBe("agent_set_posture")
    expect(verbFor("route")).toBe("session_restart")
    expect(verbFor("access")).toBe("session_restart")
    expect(verbFor("contextProfile")).toBe("session_restart")
  })

  it("restart-only chips carry the '⟲ restart required' affix; live chips do not", () => {
    const chips = buildSessionConfigChips(descriptor({ model: "claude-opus-4-8" }), fullInput())
    const chip = (axis: string) => chips.find(c => c.axis === axis)!
    expect(chip("route").restart).toBe(true)
    expect(chip("route").restartAffix).toBe(RESTART_AFFIX)
    expect(chip("access").restartAffix).toBe(RESTART_AFFIX)
    expect(chip("contextProfile").restartAffix).toBe(RESTART_AFFIX)
    // Live chips: no persistent affix.
    expect(chip("model").restart).toBe(false)
    expect(chip("model").restartAffix).toBeUndefined()
    expect(chip("effort").restartAffix).toBeUndefined()
    expect(chip("posture").restartAffix).toBeUndefined()
  })
})

describe("model chip — the model↔route restart trap surfaces through the chip", () => {
  it("flags a gateway model bound to a different route as restartRequired", () => {
    const chips = buildSessionConfigChips(
      descriptor({ model: "claude-sonnet-5" }), // native, session.mode undefined
      baseInput({
        model: "claude-sonnet-5",
        adapter: adapter({
          modelDetails: [
            { id: "claude-sonnet-5", provider: "anthropic" },
            { id: "kimi-k2.7-code", provider: "moonshot", mode: "moonshot" },
          ],
        }),
      }),
    )
    const modelChip = chips.find(c => c.axis === "model")!
    const gateway = modelChip.rows.find(r => r.value === "kimi-k2.7-code")
    const native = modelChip.rows.find(r => r.value === "claude-sonnet-5")
    expect(gateway?.restartRequired).toBe(true) // crosses route → restart
    expect(native?.restartRequired).toBe(false) // same (native) route → live
    // The model chip itself stays a LIVE chip — the trap is per-row.
    expect(modelChip.restart).toBe(false)
  })

  it("carries the route suffix from the change-model rows onto the chip", () => {
    const chips = buildSessionConfigChips(
      descriptor({ model: "z-ai/glm-5.2@openrouter" }),
      baseInput({
        model: "z-ai/glm-5.2@openrouter",
        adapter: adapter({
          modelDetails: [
            { id: "z-ai/glm-5.2@openrouter", provider: "z-ai" },
            { id: "z-ai/glm-5.2@requesty", provider: "z-ai" },
          ],
        }),
      }),
    )
    const modelChip = chips.find(c => c.axis === "model")!
    const current = modelChip.rows.find(r => r.value === "z-ai/glm-5.2@openrouter")
    const other = modelChip.rows.find(r => r.value === "z-ai/glm-5.2@requesty")
    expect(current?.description).toBe("current · via openrouter")
    expect(other?.description).toBe("restart required · via requesty")
  })

  it("flags EVERY model row restart-required for an 'arg' adapter (e.g. codex)", () => {
    const chips = buildSessionConfigChips(
      descriptor({ model: "o4-mini" }),
      baseInput({
        model: "o4-mini",
        adapter: adapter({ slug: "codex", modelApply: "arg", modelDetails: [{ id: "o4-mini" }, { id: "o4" }] }),
      }),
    )
    const modelChip = chips.find(c => c.axis === "model")!
    expect(modelChip.rows.every(r => r.restartRequired)).toBe(true)
  })
})

describe("posture chip — mixes live native + restart advisory rows", () => {
  it("native rows are live; advisory rows are individually restart-tagged", () => {
    const chips = buildSessionConfigChips(
      descriptor({ model: "claude-opus-4-8" }),
      baseInput({ availableModes: [{ id: "plan", name: "Plan" }] }),
    )
    const posture = chips.find(c => c.axis === "posture")!
    expect(posture.restart).toBe(false) // live chip class
    const plan = posture.rows.find(r => r.value === "plan")
    const bypass = posture.rows.find(r => r.value === "bypass")
    expect(plan?.enforcement).toBe("enforced")
    expect(plan?.restartRequired).toBe(false)
    expect(bypass?.enforcement).toBe("advisory")
    expect(bypass?.restartRequired).toBe(true)
  })
})

describe("access chip — surfaces the ineligible-attached-profile re-pick", () => {
  it("carries ineligibleAttachedProfile when the wallet no longer fits the route (Rx)", () => {
    const chips = buildSessionConfigChips(
      descriptor({
        model: "claude-opus-4-8",
        route: { gateway: "moonshot" },
        accessProfile: {
          profileRef: "jeremy-max",
          vendor: "anthropic",
          method: "oauth-bearer",
          label: "Jeremy Max",
        },
      }),
      baseInput({
        catalog: catalog(),
        profiles: [{ id: "jeremy-max", endpoint: "anthropic", method: "oauth-bearer" as const }],
      }),
    )
    const access = chips.find(c => c.axis === "access")!
    expect(access.ineligibleAttachedProfile).toBe("jeremy-max")
  })

  it("does NOT flag an attached profile when the model's pinned @route makes it eligible", () => {
    const chips = buildSessionConfigChips(
      descriptor({
        model: "z-ai/glm-5.2@openrouter",
        route: { gateway: "requesty" },
        accessProfile: {
          profileRef: "or-key",
          vendor: "openrouter",
          method: "api-key",
          label: "OpenRouter",
        },
      }),
      baseInput({
        catalog: routerCatalog(),
        profiles: [{ id: "or-key", endpoint: "openrouter", method: "api-key" as const }],
      }),
    )
    const access = chips.find(c => c.axis === "access")!
    expect(access.ineligibleAttachedProfile).toBeUndefined()
    expect(access.rows.filter(r => r.value).map(r => r.value)).toEqual(["or-key"])
  })
})

describe("buildSessionActions — interrupt enabled only while busy", () => {
  it("enables interrupt when the session is busy, disables it otherwise", () => {
    const busy = buildSessionActions({ busy: true })
    const idle = buildSessionActions({ busy: false })
    expect(busy.find(a => a.kind === "interrupt")?.enabled).toBe(true)
    expect(idle.find(a => a.kind === "interrupt")?.enabled).toBe(false)
  })

  it("treats an unset busy flag as not-busy (interrupt disabled)", () => {
    expect(buildSessionActions({}).find(a => a.kind === "interrupt")?.enabled).toBe(false)
  })

  it("stop is always enabled and bound to the kill verb", () => {
    const stop = buildSessionActions({ busy: true }).find(a => a.kind === "stop")
    expect(stop?.enabled).toBe(true)
    expect(stop?.verb).toBe("session_kill")
  })

  it("interrupt is bound to agent_interrupt (turn cancel, session survives)", () => {
    const interrupt = buildSessionActions({ busy: true }).find(a => a.kind === "interrupt")
    expect(interrupt?.verb).toBe("agent_interrupt")
  })
})
