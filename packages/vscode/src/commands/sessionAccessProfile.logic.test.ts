import { describe, expect, it } from "vitest"

import type {
  AuthProfileSummary,
  CatalogModelsResponse,
  SessionDescriptor,
} from "../client/types.js"
import {
  accessRowsForSession,
  planAccessChange,
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
  it("offers the route-eligible profiles plus a trailing add-profile row", () => {
    const { rows } = accessRowsForSession({ descriptor: descriptor(), catalog, profiles })
    expect(rows.filter(r => r.value).map(r => r.value)).toEqual(["max-agentik", "max-fabrikapp"])
    expect(rows.at(-1)?.addProfile).toBe(true)
  })

  it("excludes profiles not eligible for the route (openrouter key on an anthropic route)", () => {
    const { rows } = accessRowsForSession({ descriptor: descriptor(), catalog, profiles })
    expect(rows.map(r => r.value)).not.toContain("or-key")
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

  it("still offers add-profile when the catalog knows no route for the model", () => {
    const { rows } = accessRowsForSession({ descriptor: descriptor({ model: "unknown-model" }), catalog, profiles })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.addProfile).toBe(true)
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
