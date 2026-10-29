import { describe, it, expect } from "vitest"
import type { AuthProfile } from "@agentproto/auth"
import {
  profileAllowsModelId,
  profileModelAllowlistMessage,
  stripModelContextHint,
} from "../auth-profile-model-allowlist.js"

const profile = (ids: string[]): Pick<AuthProfile, "models"> => ({
  models: { mode: "allow", ids },
})

describe("profileAllowsModelId — identity matrix", () => {
  it("admits every model when curation is absent or mode:all", () => {
    expect(profileAllowsModelId({}, "anything/at-all")).toBe(true)
    expect(
      profileAllowsModelId({ models: { mode: "all", ids: ["only-this"] } }, "other-model"),
    ).toBe(true)
  })

  it("matches a bare product on a DIRECT route", () => {
    expect(
      profileAllowsModelId(profile(["claude-opus-4-8"]), "claude-opus-4-8", { route: "anthropic" }),
    ).toBe(true)
  })

  it("does NOT match a bare product on a GATEWAY route (would over-widen)", () => {
    expect(
      profileAllowsModelId(profile(["glm-5.2"]), "glm-5.2", { route: "openrouter" }),
    ).toBe(false)
  })

  it("matches vendor/product and route-qualified refs on a gateway", () => {
    expect(
      profileAllowsModelId(profile(["z-ai/glm-5.2"]), "z-ai/glm-5.2", { route: "openrouter" }),
    ).toBe(true)
    expect(
      profileAllowsModelId(profile(["z-ai/glm-5.2@openrouter"]), "z-ai/glm-5.2@openrouter", {
        route: "openrouter",
      }),
    ).toBe(true)
  })

  it("normalizes a router-prefixed id to the canonical vendor/product", () => {
    expect(
      profileAllowsModelId(profile(["z-ai/glm-5.2"]), "openrouter/z-ai/glm-5.2", {
        route: "openrouter",
      }),
    ).toBe(true)
  })

  it("treats a context-lane hint as not part of identity", () => {
    expect(profileAllowsModelId(profile(["claude-sonnet-5-5"]), "claude-sonnet-5-5[1m]", { route: "anthropic" })).toBe(true)
    expect(profileAllowsModelId(profile(["claude-sonnet-5-5[1m]"]), "claude-sonnet-5-5", { route: "anthropic" })).toBe(true)
    expect(stripModelContextHint("claude-opus-5-5[200k]")).toBe("claude-opus-5-5")
  })

  it("does not match an unrelated id", () => {
    expect(
      profileAllowsModelId(profile(["claude-sonnet-5-5"]), "claude-sonnet-5", { route: "anthropic" }),
    ).toBe(false)
  })

  it("names the profile, model and allowed ids in the refusal", () => {
    expect(profileModelAllowlistMessage("p1", "m1", ["a", "b"])).toContain(
      'auth profile "p1" does not allow model "m1" (models.mode: "allow", allowed ids: a, b).',
    )
  })
})
