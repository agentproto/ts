/**
 * The workflow execution profile gate: what a spawn target may be BEFORE
 * anything spawns. Pure lookups — no sessions, no network.
 */

import { describe, expect, it } from "vitest"

import {
  resolveAndValidateTarget,
  resolveExecProfile,
  validateSpawnTarget,
  type PresetLookups,
} from "../decision-profile.js"

const free = () => {
  const r = resolveExecProfile({ profile: "local-free" })
  if (!r.ok) throw new Error(r.error)
  return r.profile
}
const sub = () => {
  const r = resolveExecProfile({ profile: "remote-sonnet" })
  if (!r.ok) throw new Error(r.error)
  return r.profile
}

const lookups = (over: Partial<PresetLookups> = {}): PresetLookups => ({
  getHarnessPreset: async id =>
    ({
      "oc-free": { id, harnessSlug: "opencode", name: id, profileRef: "zen", defaultModel: "glm-4.7-free", isDefault: false },
      "oc-big": { id, harnessSlug: "opencode", name: id, profileRef: "zen", defaultModel: "big-pickle", isDefault: false },
      "oc-paid": { id, harnessSlug: "opencode", name: id, profileRef: "zen", defaultModel: "kimi-k2-thinking", isDefault: false },
      "cc-sonnet": { id, harnessSlug: "claude-code", name: id, profileRef: "claude-sub", defaultModel: "claude-sonnet-4-5", isDefault: false },
      "cc-opus": { id, harnessSlug: "claude-code", name: id, profileRef: "claude-sub", defaultModel: "claude-opus-4-1", isDefault: false },
      "no-model": { id, harnessSlug: "opencode", name: id, profileRef: "zen", isDefault: false },
    })[id as string] as never,
  getUserPreset: async id =>
    ({
      "user-free": { id, label: id, adapter: "opencode", model: "qwen-free" },
      "user-route": { id, label: id, adapter: "opencode", model: "glm-free", route: "gateway" },
      "user-rotate-paid": {
        id,
        label: id,
        adapter: "opencode",
        model: "glm-free",
        turnRetry: { rotate: [{ model: "claude-sonnet-4-5" }] },
      },
      "user-rotate-free": {
        id,
        label: id,
        adapter: "opencode",
        model: "glm-free",
        turnRetry: { rotate: [{ model: "other-free" }] },
      },
      "user-openrouter": { id, label: id, adapter: "opencode", model: "openrouter/foo-free" },
      "user-at-route": { id, label: id, adapter: "opencode", model: "glm-free@fast" },
    })[id as string] as never,
  getAuthProfile: async id => ({ id, endpoint: id === "or-profile" ? "openrouter" : "opencode-go", method: { kind: "api-key" } }) as never,
  getDefaultHarnessPreset: async () => undefined,
  ...over,
})

describe("resolveExecProfile", () => {
  it("defaults to local-free and maps the GATE_EXEC_PROFILE spellings", () => {
    expect(resolveExecProfile()).toMatchObject({ ok: true, profile: { id: "local-free", entitlement: "free-only" } })
    expect(resolveExecProfile({ profile: "free-only" })).toMatchObject({ ok: true, profile: { id: "local-free" } })
    expect(resolveExecProfile({ profile: "subscription" })).toMatchObject({
      ok: true,
      profile: { id: "remote-sonnet", entitlement: "subscription" },
    })
  })

  it("rejects an unknown profile and never lets input widen the entitlement", () => {
    expect(resolveExecProfile({ profile: "paid-everything" })).toMatchObject({ ok: false })
    const r = resolveExecProfile({ profile: "local-free", escalation: { adapter: "claude-code", model: "claude-sonnet-4-5" } })
    if (!r.ok) throw new Error("expected ok")
    expect(r.profile.entitlement).toBe("free-only")
  })

  it("local-free has no default escalation target; Jev is off", () => {
    const p = free()
    expect(p.jev.enabled).toBe(false)
    expect(p.escalation.preset).toBeUndefined()
    expect(p.escalation.model).toBeUndefined()
    expect(p.escalation.roleDefault).toBeUndefined()
  })

  it("clamps operator deadlines", () => {
    const r = resolveExecProfile({ profile: "local-free", escalation: { preset: "x", timeoutMs: 99 * 3_600_000 }, reviewTimeoutMs: 99 * 3_600_000 })
    if (!r.ok) throw new Error("expected ok")
    expect(r.profile.escalation.timeoutMs).toBeLessThanOrEqual(10 * 60_000)
    expect(r.profile.review.timeoutMs).toBeLessThanOrEqual(60 * 60_000)
  })
})

describe("validateSpawnTarget", () => {
  it("free-only permits only OpenCode -free / big-pickle", () => {
    expect(validateSpawnTarget(free(), { adapter: "opencode", model: "glm-4.7-free" })).toMatchObject({ ok: true })
    expect(validateSpawnTarget(free(), { adapter: "opencode", model: "big-pickle" })).toMatchObject({ ok: true })
    expect(validateSpawnTarget(free(), { adapter: "opencode", model: "kimi-k2-thinking" })).toMatchObject({ ok: false, code: "not_entitled" })
    expect(validateSpawnTarget(free(), { adapter: "claude-code", model: "claude-sonnet-4-5" })).toMatchObject({ ok: false, code: "not_entitled" })
  })

  it("subscription adds Claude Code Sonnet — and only Sonnet", () => {
    expect(validateSpawnTarget(sub(), { adapter: "claude-code", model: "claude-sonnet-4-5" })).toMatchObject({ ok: true })
    expect(validateSpawnTarget(sub(), { adapter: "claude-code", model: "claude-opus-4-1" })).toMatchObject({ ok: false })
    expect(validateSpawnTarget(sub(), { adapter: "codex", model: "gpt-5" })).toMatchObject({ ok: false })
  })

  it("fails closed on unknown or dynamic identity", () => {
    expect(validateSpawnTarget(free(), { model: "x-free" })).toMatchObject({ ok: false, code: "unknown_adapter" })
    expect(validateSpawnTarget(free(), { adapter: "opencode" })).toMatchObject({ ok: false, code: "unknown_model" })
    expect(validateSpawnTarget(free(), { adapter: "opencode", model: "glm-free@fast" })).toMatchObject({ ok: false })
    expect(validateSpawnTarget(free(), { adapter: "opencode", model: "openrouter/x-free" })).toMatchObject({ ok: false })
    expect(validateSpawnTarget(free(), { adapter: "opencode", model: "glm-free", route: "gw" })).toMatchObject({ ok: false, code: "route_not_free" })
  })

  it("checks every rotate fallback, and ignores sandbox placement entirely", () => {
    expect(
      validateSpawnTarget(free(), { adapter: "opencode", model: "a-free", rotate: [{ model: "claude-sonnet-4-5" }] }),
    ).toMatchObject({ ok: false, code: "rotate_not_entitled" })
    expect(
      validateSpawnTarget(free(), { adapter: "opencode", model: "a-free", rotate: [{ model: "mystery-model" }] }),
    ).toMatchObject({ ok: false, code: "unknown_rotate" })
    // E2B (or any) placement grants no entitlement and removes none.
    expect(validateSpawnTarget(free(), { adapter: "claude-code", model: "claude-sonnet-4-5", sandbox: { provider: "e2b" } })).toMatchObject({ ok: false })
    expect(validateSpawnTarget(free(), { adapter: "opencode", model: "a-free", sandbox: { provider: "e2b" } })).toMatchObject({ ok: true })
  })
})

describe("resolveAndValidateTarget — presets, roles, overrides", () => {
  it("resolves free harness and user presets under free-only", async () => {
    for (const preset of ["oc-free", "oc-big", "user-free", "user-rotate-free"]) {
      expect(await resolveAndValidateTarget(free(), { preset }, lookups())).toMatchObject({ ok: true })
    }
  })

  it("free-only refuses Sonnet, a paid OpenCode id, paid rotate targets and a missing model — nothing substituted", async () => {
    expect(await resolveAndValidateTarget(free(), { preset: "cc-sonnet" }, lookups())).toMatchObject({ ok: false, code: "not_entitled" })
    expect(await resolveAndValidateTarget(free(), { preset: "oc-paid" }, lookups())).toMatchObject({ ok: false, code: "not_entitled" })
    expect(await resolveAndValidateTarget(free(), { preset: "user-rotate-paid" }, lookups())).toMatchObject({ ok: false, code: "rotate_not_entitled" })
    expect(await resolveAndValidateTarget(free(), { preset: "no-model" }, lookups())).toMatchObject({ ok: false, code: "unknown_model" })
    expect(await resolveAndValidateTarget(free(), { preset: "user-route" }, lookups())).toMatchObject({ ok: false, code: "route_not_free" })
    expect(await resolveAndValidateTarget(free(), { preset: "user-at-route" }, lookups())).toMatchObject({ ok: false })
    expect(await resolveAndValidateTarget(free(), { preset: "ghost" }, lookups())).toMatchObject({ ok: false, code: "preset_not_found" })
    expect(await resolveAndValidateTarget(free(), {}, lookups())).toMatchObject({ ok: false, code: "no_target" })
  })

  it("subscription accepts the configured Claude Code Sonnet preset but still refuses Opus", async () => {
    expect(await resolveAndValidateTarget(sub(), { preset: "cc-sonnet" }, lookups())).toMatchObject({
      ok: true,
      adapter: "claude-code",
      model: "claude-sonnet-4-5",
    })
    expect(await resolveAndValidateTarget(sub(), { preset: "cc-opus" }, lookups())).toMatchObject({ ok: false })
  })

  it("an actual role/recovery model override is what gets validated", async () => {
    // The preset is free, but the override swaps in Sonnet: refused under free-only.
    expect(await resolveAndValidateTarget(free(), { preset: "oc-free" }, lookups(), { model: "claude-sonnet-4-5" })).toMatchObject({ ok: false })
    expect(await resolveAndValidateTarget(free(), { preset: "oc-free" }, lookups(), { model: "other-free" })).toMatchObject({ ok: true, model: "other-free" })
  })

  it("explicit adapter+model targets are validated the same way", async () => {
    expect(await resolveAndValidateTarget(free(), { adapter: "opencode", model: "x-free" }, lookups())).toMatchObject({ ok: true })
    expect(await resolveAndValidateTarget(free(), { adapter: "claude-code", model: "claude-sonnet-4-5" }, lookups())).toMatchObject({ ok: false })
    expect(await resolveAndValidateTarget(free(), { model: "mystery" }, lookups())).toMatchObject({ ok: false, code: "unknown_adapter" })
  })

  it("roleDefault takes review.small; a gateway-routed or adapter-less role fails closed", async () => {
    const withRole = (role: unknown) => lookups({ resolveRole: () => role as never })
    expect(
      await resolveAndValidateTarget(sub(), { roleDefault: true }, withRole({ model: "claude-sonnet-4-5", adapter: "claude-code" })),
    ).toMatchObject({ ok: true, model: "claude-sonnet-4-5" })
    expect(
      await resolveAndValidateTarget(sub(), { roleDefault: true }, withRole({ model: "claude-sonnet-4-5", adapter: "claude-code", route: "gw" })),
    ).toMatchObject({ ok: false, code: "route_not_free" })
    expect(await resolveAndValidateTarget(sub(), { roleDefault: true }, withRole({ model: "x" }))).toMatchObject({ ok: false, code: "unknown_adapter" })
    expect(await resolveAndValidateTarget(sub(), { roleDefault: true }, lookups())).toMatchObject({ ok: false, code: "no_target" })
  })

  it("refuses an OpenRouter-billing auth profile and an unreadable one; checks the inherited default profile", async () => {
    expect(
      await resolveAndValidateTarget(free(), { adapter: "opencode", model: "x-free", profileRef: "or-profile" }, lookups()),
    ).toMatchObject({ ok: false, code: "openrouter" })
    expect(
      await resolveAndValidateTarget(
        free(),
        { adapter: "opencode", model: "x-free", profileRef: "any" },
        lookups({
          getAuthProfile: async () => {
            throw new Error("keychain locked")
          },
        }),
      ),
    ).toMatchObject({ ok: false, code: "openrouter" })
    // No profile named: the harness default preset's profile is what a bare spawn would use.
    expect(
      await resolveAndValidateTarget(
        free(),
        { adapter: "opencode", model: "x-free" },
        lookups({ getDefaultHarnessPreset: async () => ({ profileRef: "or-profile" }) }),
      ),
    ).toMatchObject({ ok: false, code: "openrouter" })
    expect(
      await resolveAndValidateTarget(
        free(),
        { adapter: "opencode", model: "x-free" },
        lookups({
          getDefaultHarnessPreset: async () => {
            throw new Error("store unreadable")
          },
        }),
      ),
    ).toMatchObject({ ok: false, code: "profile_unreadable" })
  })
})
