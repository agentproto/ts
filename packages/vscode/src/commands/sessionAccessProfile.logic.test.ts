import { describe, expect, it } from "vitest"

import type {
  AuthProfileSummary,
  CatalogModelsResponse,
  SessionDescriptor,
} from "../client/types.js"
import {
  accessRowsForSession,
  applyAccessProfile,
  planAccessChange,
  withEligibleAccess,
} from "./sessionAccessProfile.logic.js"

const catalog: CatalogModelsResponse = {
  vendors: [
    {
      vendor: "anthropic",
      products: [
        {
          product: "claude-opus",
          routes: [
            {
              route: "anthropic",
              ref: "anthropic/claude-opus",
              baseUrl: null,
              pricing: null,
              runnable: true,
              eligibleProfiles: ["max-agentik", "max-fabrikapp"],
              adapterModes: [],
              adapters: ["claude-code"],
              curated: true,
            },
          ],
        },
      ],
    },
  ],
}

const routerCatalog: CatalogModelsResponse = {
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
              pricing: null,
              runnable: true,
              eligibleProfiles: ["or-key"],
              adapterModes: [],
              adapters: ["claude-code"],
              curated: true,
            },
            {
              route: "requesty",
              ref: "z-ai/glm-5.2@requesty",
              baseUrl: "https://requesty.ai",
              pricing: null,
              runnable: true,
              eligibleProfiles: ["requesty-key"],
              adapterModes: [],
              adapters: ["claude-code"],
              curated: false,
            },
          ],
        },
      ],
    },
  ],
}

const profiles: AuthProfileSummary[] = [
  { id: "max-agentik", endpoint: "anthropic", method: "oauth-bearer", credentialRef: "r1", label: "Max agentik" },
  { id: "max-fabrikapp", endpoint: "anthropic", method: "oauth-bearer", credentialRef: "r2", label: "Max fabrikapp" },
  { id: "or-key", endpoint: "openrouter", method: "api-key", credentialRef: "r3" },
]

function descriptor(over: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "sess_1",
    kind: "agent-cli",
    status: "running",
    model: "claude-opus",
    ...over,
  } as SessionDescriptor
}

describe("accessRowsForSession", () => {
  it("offers the route-eligible profiles first, then the rest, plus a trailing add-profile row", () => {
    const { rows } = accessRowsForSession({ descriptor: descriptor(), catalog, profiles })
    expect(rows.filter(r => r.value).map(r => r.value)).toEqual([
      "max-agentik",
      "max-fabrikapp",
      "or-key",
    ])
    expect(rows.find(r => r.value === "max-agentik")?.eligible).toBe(true)
    expect(rows.at(-1)?.addProfile).toBe(true)
  })

  it("still LISTS a profile that is not eligible for the route (flagged, never hidden)", () => {
    // The picker used to show only the route-eligible profiles, so a session
    // whose route the catalog did not know offered NOTHING but
    // "+ add profile": the existing profiles in
    // ~/.agentproto/auth-profiles.json were invisible. Every profile the
    // daemon knows is listed; the ones the route rejects are flagged, and
    // the daemon stays the judge when the restart is attempted.
    const { rows } = accessRowsForSession({ descriptor: descriptor(), catalog, profiles })
    const orKey = rows.find(r => r.value === "or-key")
    expect(orKey).toBeDefined()
    expect(orKey?.eligible).toBe(false)
    expect(orKey?.label).toBe("or-key")
    expect(orKey?.description).not.toMatch(/sk-|key-/)
  })

  it("lists every existing profile when the catalog knows no route for the session", () => {
    const { rows } = accessRowsForSession({
      descriptor: descriptor({ model: "unknown-model" }),
      catalog,
      profiles,
    })
    expect(rows.filter(r => r.value).map(r => r.value)).toEqual([
      "max-agentik",
      "max-fabrikapp",
      "or-key",
    ])
    expect(rows.at(-1)?.addProfile).toBe(true)
  })

  it("reports the currently-attached profile and flags it when it turns ineligible", () => {
    const attached = accessRowsForSession({
      descriptor: descriptor({ accessProfile: { profileRef: "max-agentik", label: "Max agentik", vendor: "anthropic", method: "oauth-bearer" } }),
      catalog,
      profiles,
    })
    expect(attached.currentProfileRef).toBe("max-agentik")
    expect(attached.ineligibleAttached).toBeUndefined()

    const stale = accessRowsForSession({
      descriptor: descriptor({ accessProfile: { profileRef: "or-key", label: "OR", vendor: "openrouter", method: "api-key" } }),
      catalog,
      profiles,
    })
    expect(stale.ineligibleAttached).toBe("or-key")
  })

  it("ignores a stale route.gateway when the model ref pins a different @route", () => {
    const rows = accessRowsForSession({
      descriptor: descriptor({
        model: "z-ai/glm-5.2@openrouter",
        route: { gateway: "requesty" },
        accessProfile: { profileRef: "or-key", label: "OpenRouter", vendor: "openrouter", method: "api-key" },
      }),
      catalog: routerCatalog,
      profiles,
    })
    // The stale gateway is ignored: "or-key" is the route's eligible
    // profile (and leads the list), and "requesty-key" is not offered as
    // eligible at all.
    expect(rows.rows[0]?.value).toBe("or-key")
    expect(rows.rows.find(r => r.value === "or-key")?.eligible).toBe(true)
    expect(rows.rows.map(r => r.value)).not.toContain("requesty-key")
    expect(rows.ineligibleAttached).toBeUndefined()
  })

  it("still offers add-profile when the catalog knows no route for the model", () => {
    const { rows } = accessRowsForSession({ descriptor: descriptor({ model: "unknown-model" }), catalog, profiles })
    expect(rows.at(-1)?.addProfile).toBe(true)
  })
})

describe("planAccessChange", () => {
  it("routes the add-profile row to the create flow", () => {
    expect(planAccessChange({ picked: { addProfile: true }, isLive: true }).kind).toBe("addProfile")
  })

  it("no-ops when the picked profile is already attached", () => {
    expect(
      planAccessChange({ picked: { value: "max-agentik" }, currentProfileRef: "max-agentik", isLive: false }).kind,
    ).toBe("noop")
  })

  it("no-ops on an empty pick", () => {
    expect(planAccessChange({ picked: {}, isLive: false }).kind).toBe("noop")
  })

  it("attaches, killing first only when the session is live", () => {
    expect(planAccessChange({ picked: { value: "max-fabrikapp" }, isLive: true })).toEqual({
      kind: "attach",
      profileRef: "max-fabrikapp",
      killFirst: true,
    })
    expect(planAccessChange({ picked: { value: "max-fabrikapp" }, isLive: false })).toEqual({
      kind: "attach",
      profileRef: "max-fabrikapp",
      killFirst: false,
    })
  })
})

describe("withEligibleAccess (model switch across routes)", () => {
  const route = (r: string, eligibleProfiles: string[]) => ({
    route: r,
    ref: `deepseek-v4.1-flash-free@${r}`,
    baseUrl: null,
    pricing: null,
    runnable: true,
    eligibleProfiles,
    adapterModes: [],
    adapters: ["opencode"],
    curated: true,
  })
  const zenGoCatalog = {
    vendors: [
      {
        vendor: "deepseek",
        products: [
          {
            product: "deepseek-v4.1-flash-free",
            routes: [route("opencode", ["opencode-api-zen-ws02"]), route("opencode-go", ["opencode-ws01", "opencode-go-api"])],
          },
        ],
      },
    ],
  } as unknown as CatalogModelsResponse
  const session = {
    model: "opencode/deepseek-v4.1-flash-free",
    accessProfile: { profileRef: "opencode-api-zen-ws02" },
  } as unknown as SessionDescriptor

  it("auto-picks the first eligible profile when the route changes", () => {
    const r = withEligibleAccess({ model: "opencode-go/deepseek-v4.1-flash-free" }, session, zenGoCatalog)
    expect(r.override).toEqual({
      model: "opencode-go/deepseek-v4.1-flash-free",
      access: { profileRef: "opencode-ws01" },
    })
    expect(r.autoPickedProfile).toBe("opencode-ws01")
  })

  it("keeps the attached profile when it is eligible on the target route", () => {
    const r = withEligibleAccess({ model: "opencode/deepseek-v4.1-flash-free" }, session, zenGoCatalog)
    expect(r.override).toEqual({ model: "opencode/deepseek-v4.1-flash-free" })
  })

  it("never overrides an explicit access", () => {
    const o = { model: "opencode-go/deepseek-v4.1-flash-free", access: { profileRef: "x" } }
    expect(withEligibleAccess(o, session, zenGoCatalog).override).toBe(o)
  })

  it("errors when the target route has no eligible profile", () => {
    const cat = JSON.parse(JSON.stringify(zenGoCatalog))
    cat.vendors[0].products[0].routes[1].eligibleProfiles = []
    expect(withEligibleAccess({ model: "opencode-go/deepseek-v4.1-flash-free" }, session, cat).error).toMatch(/no auth profile/)
  })
})

describe("applyAccessProfile: the chosen profile becomes a restart-with-override", () => {
  it("restarts the session onto the profile (POST /sessions/:id/restart, access.profileRef)", async () => {
    const calls: Array<{ id: string; overrides: unknown }> = []
    const result = await applyAccessProfile({
      applier: {
        async restartSessionWithOverride(id, overrides) {
          calls.push({ id, overrides })
          return { id: "sess_new", resumedFrom: "sess_1" }
        },
      },
      sessionId: "sess_1",
      profileRef: "max-fabrikapp",
    })
    expect(calls).toEqual([
      { id: "sess_1", overrides: { access: { profileRef: "max-fabrikapp" } } },
    ])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.restart?.id).toBe("sess_new")
  })

  it("reports the daemon's refusal instead of throwing", async () => {
    const result = await applyAccessProfile({
      applier: {
        async restartSessionWithOverride() {
          throw new Error("HTTP 400: profile \"nope\" is not eligible on route anthropic")
        },
      },
      sessionId: "sess_1",
      profileRef: "nope",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("not eligible")
  })
})
