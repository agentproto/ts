import { describe, expect, it } from "vitest"
import type { AuthProfile } from "@agentproto/auth"
import { eligibleProfilesForRoute, spawnEligibilityManifest } from "../eligibility-manifest.js"
import { buildCatalogModels, type CatalogAdapterInput } from "../catalog-models.js"
import type { AdapterAuthDescriptor } from "../spawn-defaults.js"

const OPENCODE_LIKE: AdapterAuthDescriptor = { modelDerivedApiKey: true }
const ZEN_MODEL = "opencode/nemotron-3-ultra-free"
const OTHER_ZEN_MODEL = "opencode/gpt-5.4-nano"
const GO_MODEL = "opencode-go/kimi-k2.7"

const orgProfile = (overrides: Partial<AuthProfile> = {}): AuthProfile => ({
  id: "opencode-default",
  endpoint: "opencode-go",
  method: "api-key",
  source: "opencode-console",
  subaccount: { kind: "org", id: "wrk_1" },
  ...overrides,
})
const allow = (...ids: string[]): AuthProfile["models"] => ({ mode: "allow", ids })

function eligible(profile: AuthProfile, model: string): string[] {
  const projected = spawnEligibilityManifest("opencode", OPENCODE_LIKE, undefined, model)
  if (!projected) throw new Error("no projection")
  return eligibleProfilesForRoute([profile], projected.manifest, projected.routeId, model).map(p => p.id)
}

describe("eligibleProfilesForRoute — opencode console org on the Zen route", () => {
  it("is eligible on the opencode-go route (its own endpoint)", () => {
    expect(eligible(orgProfile(), GO_MODEL)).toEqual(["opencode-default"])
  })

  it("is eligible on the opencode route when the allow-list names the route-qualified id", () => {
    expect(eligible(orgProfile({ models: allow(ZEN_MODEL) }), ZEN_MODEL)).toEqual(["opencode-default"])
  })

  it("stays eligible on the opencode-go route with an allow-list (the Zen id does not matter there)", () => {
    expect(eligible(orgProfile({ models: allow(ZEN_MODEL) }), GO_MODEL)).toEqual(["opencode-default"])
  })

  it("is NOT eligible on the opencode route for an id missing from the allow-list", () => {
    expect(eligible(orgProfile({ models: allow(ZEN_MODEL) }), OTHER_ZEN_MODEL)).toEqual([])
  })

  it("is NOT eligible on the opencode route with an empty allow-list", () => {
    expect(eligible(orgProfile({ models: allow() }), ZEN_MODEL)).toEqual([])
  })

  it("is NOT eligible on the opencode route without curation (Zen bills a pay-as-you-go wallet)", () => {
    expect(eligible(orgProfile(), ZEN_MODEL)).toEqual([])
    expect(eligible(orgProfile({ models: { mode: "all", ids: [] } }), ZEN_MODEL)).toEqual([])
    expect(eligible(orgProfile({ models: { mode: "all", ids: [ZEN_MODEL] } }), ZEN_MODEL)).toEqual([])
  })

  it("does not widen a plain api-key opencode-go profile, even with an allow-list", () => {
    const plain: AuthProfile = {
      id: "opencode-go-api",
      endpoint: "opencode-go",
      method: "api-key",
      credentialRef: "agentproto.auth.opencode-go.key",
      models: allow(ZEN_MODEL),
    }
    expect(eligible(plain, ZEN_MODEL)).toEqual([])
    expect(eligible(plain, GO_MODEL)).toEqual(["opencode-go-api"])
  })

  it("does not widen a console profile pinned to a non-org sub-account or another source", () => {
    const models = allow(ZEN_MODEL)
    expect(eligible(orgProfile({ models, subaccount: { kind: "project", id: "p1" } }), ZEN_MODEL)).toEqual([])
    expect(eligible(orgProfile({ models, source: "something-else" }), ZEN_MODEL)).toEqual([])
  })

  it("leaves a plain opencode (Zen) api-key profile on its own route", () => {
    const zen: AuthProfile = {
      id: "opencode-zen-free",
      endpoint: "opencode",
      method: "api-key",
      credentialRef: "agentproto.auth.opencode.key",
    }
    expect(eligible(zen, ZEN_MODEL)).toEqual(["opencode-zen-free"])
    expect(eligible(zen, GO_MODEL)).toEqual([])
  })

  it("still respects a disabled org profile", () => {
    expect(eligible(orgProfile({ models: allow(ZEN_MODEL), disabled: true }), ZEN_MODEL)).toEqual([])
  })
})

describe("buildCatalogModels — opencode console org on the Zen route", () => {
  const adapter: CatalogAdapterInput = {
    slug: "opencode",
    models: [
      { id: ZEN_MODEL, provider: "opencode" },
      { id: OTHER_ZEN_MODEL, provider: "opencode" },
    ],
    authDescriptor: OPENCODE_LIKE,
    routeSelection: "derived-from-model",
  }

  function runnableRefs(profile: AuthProfile): Record<string, string[]> {
    const response = buildCatalogModels({
      adapters: [adapter],
      profiles: [profile],
      query: { adapter: "opencode" },
    })
    const out: Record<string, string[]> = {}
    for (const vendor of response.vendors) {
      if (vendor.vendor !== "opencode") continue
      for (const product of vendor.products) {
        for (const route of product.routes) out[`${vendor.vendor}/${product.product}`] = route.eligibleProfiles
      }
    }
    return out
  }

  it("offers the org profile only for the allow-listed Zen id", () => {
    expect(runnableRefs(orgProfile({ models: allow(ZEN_MODEL) }))).toEqual({
      [ZEN_MODEL]: ["opencode-default"],
      [OTHER_ZEN_MODEL]: [],
    })
  })

  it("offers an uncurated org profile for no Zen id", () => {
    expect(runnableRefs(orgProfile())).toEqual({ [ZEN_MODEL]: [], [OTHER_ZEN_MODEL]: [] })
  })
})
