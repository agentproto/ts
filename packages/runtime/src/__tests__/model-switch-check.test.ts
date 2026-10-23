/**
 * `createModelSwitchCheck` — the eligibility gate wired into
 * `SessionsRegistry.setModel` for LIVE manual model switches. Mirrors the
 * rotation guards: a free session never moves to a paid id, a target not in
 * the profile's model allow-list is refused (delegated logic, not a copy).
 */

import { describe, it, expect } from "vitest"
import type { AuthProfile } from "@agentproto/auth"
import type { SessionDescriptor } from "../sessions.js"
import { createModelSwitchCheck } from "../model-switch-check.js"

function desc(model: string, profileRef?: string): SessionDescriptor {
  return {
    id: "s1",
    kind: "agent-cli",
    model,
    ...(profileRef
      ? { accessProfile: { profileRef, endpoint: "opencode", method: "api-key" } }
      : {}),
  } as SessionDescriptor
}

const zenProfile = {
  id: "zen",
  endpoint: "opencode",
  method: "api-key",
  models: { mode: "allow", ids: ["opencode/ling-3.1-flash-free", "opencode/big-pickle"] },
} as AuthProfile

const wired = () =>
  createModelSwitchCheck({
    getProfile: async id => (id === "zen" ? zenProfile : undefined),
  })

describe("createModelSwitchCheck", () => {
  it("refuses a paid target for a free session, wording straight from rotation", async () => {
    await expect(wired()(desc("opencode/big-pickle"), "opencode/gpt-5.1-codex")).resolves.toBe(
      "paid model — a free session never switches onto a paid id",
    )
  })

  it("delegates the allow-list refusal to the rotation-target check", async () => {
    const check = wired()
    await expect(
      check(desc("opencode/ling-3.1-flash-free", "zen"), "opencode/kimi-k9-free"),
    ).resolves.toBe(`not in profile "zen"'s model allow-list`)
  })

  it("refuses when the session names a missing profile", async () => {
    const check = wired()
    await expect(
      check(desc("opencode/ling-3.1-flash-free", "gone"), "opencode/big-pickle"),
    ).resolves.toBe(`profile "gone" is missing`)
  })

  it("passes an allowed same-profile switch", async () => {
    const check = wired()
    await expect(
      check(desc("opencode/ling-3.1-flash-free", "zen"), "opencode/big-pickle"),
    ).resolves.toBeUndefined()
  })

  it("passes a paid target for a paid session (only free stays free)", async () => {
    const check = wired()
    await expect(
      check(desc("opencode/gpt-5.1-codex"), "opencode/kimi-k9-codex"),
    ).resolves.toBeUndefined()
  })
})
