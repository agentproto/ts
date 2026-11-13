/**
 * Account slots (`accountSlots` in config.json, `slot:<name>` profileRefs):
 * the single resolver, its config key, the swap and the profileRef entries
 * that accept (or explicitly refuse) a slot.
 *
 * Hermetic: a temp HOME holds config.json and auth-profiles.json, so the
 * resolver runs its real code path (config read + profile store) without
 * touching the machine's own files.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { addAuthProfile, type AuthProfile } from "@agentproto/auth"

import {
  AccountSlotError,
  applyAccountSlotSwap,
  carriedAccessSlot,
  listAccountSlotRows,
  planAccountSlotSwap,
  resolveAccessSlots,
  resolveProfileRef,
  sessionsToMoveOnSwap,
} from "../account-slots.js"
import { runAccountSlotSwap } from "../account-slot-tools.js"
import { findConfigKey, findUnclassifiedConfigPaths, validateConfig, validateConfigKeyValue } from "../config-schema.js"
import { resolveEnvProfiles } from "../sandbox-exec-env-profiles.js"
import { addHarnessPreset, getHarnessPreset, HarnessPresetValidationError } from "../harness-preset-store.js"
import { registerLlmEndpointTools } from "../llm-endpoint-tools.js"
import type { LlmEndpointRegistry } from "../llm-endpoint-registry.js"
import { resolveAndValidateTarget, resolveExecProfile } from "../decision-profile.js"
import type { SessionDescriptor } from "../sessions.js"

let prevHome: string | undefined
let home: string

async function writeSlots(slots: Record<string, string>): Promise<void> {
  await mkdir(join(home, ".agentproto"), { recursive: true })
  await writeFile(join(home, ".agentproto", "config.json"), JSON.stringify({ accountSlots: slots }, null, 2))
}

function profile(id: string, over: Partial<AuthProfile> = {}): AuthProfile {
  return { id, endpoint: "anthropic", method: "oauth-bearer", ...over }
}

beforeEach(async () => {
  prevHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-account-slots-"))
  process.env.HOME = home
  await addAuthProfile(profile("acct-a"))
  await addAuthProfile(profile("acct-b"))
  await addAuthProfile(profile("acct-off", { disabled: true }))
  await writeSlots({ "claude-primary": "acct-a", "claude-secondary": "acct-b", "claude-dead": "acct-off", "claude-gone": "nope" })
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

describe("resolveProfileRef", () => {
  it("resolves slot:<name> to the profile the slot points at", async () => {
    await expect(resolveProfileRef("slot:claude-primary")).resolves.toEqual({ profileRef: "acct-a", slot: "claude-primary" })
  })

  it("passes a plain profile id through unchanged (no slot, no lookup)", async () => {
    await expect(resolveProfileRef("acct-b")).resolves.toEqual({ profileRef: "acct-b" })
    await expect(resolveProfileRef("does-not-exist")).resolves.toEqual({ profileRef: "does-not-exist" })
  })

  it("follows the config at the moment of use (a later swap is honoured)", async () => {
    await writeSlots({ "claude-primary": "acct-b" })
    await expect(resolveProfileRef("slot:claude-primary")).resolves.toMatchObject({ profileRef: "acct-b" })
  })

  it("an unknown slot is an explicit error naming the defined slots", async () => {
    const err = await resolveProfileRef("slot:claude-tertiary").catch(e => e)
    expect(err).toBeInstanceOf(AccountSlotError)
    expect(err.code).toBe("account_slot_unknown")
    expect(err.message).toMatch(/claude-tertiary.*not defined.*claude-primary/)
  })

  it("a slot on a disabled profile is an error, never a fallback", async () => {
    const err = await resolveProfileRef("slot:claude-dead").catch(e => e)
    expect(err).toMatchObject({ code: "account_slot_profile_disabled" })
    expect(err.message).toMatch(/acct-off.*disabled/)
  })

  it("a slot on a missing profile is an error", async () => {
    await expect(resolveProfileRef("slot:claude-gone")).rejects.toMatchObject({ code: "account_slot_profile_missing" })
  })

  it("refuses a malformed slot name and a slot pointing at another slot", async () => {
    await expect(resolveProfileRef("slot:with.dot")).rejects.toMatchObject({ code: "account_slot_invalid" })
    await expect(
      resolveProfileRef("slot:a", { loadAccountSlots: async () => ({ a: "slot:b" }) }),
    ).rejects.toMatchObject({ code: "account_slot_invalid" })
  })

  it("resolveAccessSlots maps profileRef, profileRefs and delegateProfileRefs", async () => {
    const out = await resolveAccessSlots({
      profileRef: "slot:claude-primary",
      profileRefs: ["slot:claude-secondary", "literal"],
      delegateProfileRefs: ["slot:claude-secondary"],
    })
    expect(out.access).toEqual({
      profileRef: "acct-a",
      profileRefs: ["acct-b", "literal"],
      delegateProfileRefs: ["acct-b"],
    })
    expect(Object.fromEntries(out.slotByProfile)).toEqual({ "acct-a": "claude-primary", "acct-b": "claude-secondary" })
  })

  it("carriedAccessSlot keeps a slot only while it still points at the billed profile", async () => {
    const prev = { accessSlot: "claude-primary", accessProfile: { profileRef: "acct-a" } }
    await expect(carriedAccessSlot(prev)).resolves.toBe("claude-primary")
    await writeSlots({ "claude-primary": "acct-b" })
    await expect(carriedAccessSlot(prev)).resolves.toBeUndefined()
  })
})

describe("accountSlots config key", () => {
  it("is registered so config_set accountSlots.<slot> is a known, writable key", () => {
    const entry = findConfigKey("accountSlots.claude-primary")
    expect(entry).toMatchObject({ path: "accountSlots.*", writable: true, apply: "hot" })
    expect(validateConfigKeyValue("accountSlots.claude-primary", "anthropic-sub-hodl").ok).toBe(true)
    expect(findConfigKey("accountSlots")).toMatchObject({ writable: true })
  })

  it("refuses a slot pointing at another slot, and a dotted slot name in the file", () => {
    expect(validateConfigKeyValue("accountSlots.claude-primary", "slot:claude-secondary").ok).toBe(false)
    expect(validateConfig({ accountSlots: { "claude.primary": "x" } }).ok).toBe(false)
    expect(validateConfig({ accountSlots: { "claude-primary": "x" } }).ok).toBe(true)
  })

  it("leaves no unclassified config path behind", () => {
    expect(findUnclassifiedConfigPaths()).toEqual([])
  })
})

function session(
  id: string,
  over: Partial<SessionDescriptor> & { accessSlot?: string; profileRef?: string },
): SessionDescriptor {
  const { profileRef, ...rest } = over
  return {
    id,
    kind: "agent-cli",
    status: "running",
    ...(profileRef ? { accessProfile: { profileRef, endpoint: "anthropic", method: "oauth-bearer" } } : {}),
    ...rest,
  } as SessionDescriptor
}

describe("accounts swap", () => {
  it("plans a primary <-> secondary exchange and refuses an incomplete family", async () => {
    const plan = planAccountSlotSwap({ "claude-primary": "acct-a", "claude-secondary": "acct-b" }, "claude")
    expect(plan).toMatchObject({ departing: "acct-a", arriving: "acct-b" })
    expect(plan.after).toEqual({ "claude-primary": "acct-b", "claude-secondary": "acct-a" })
    expect(() => planAccountSlotSwap({ "claude-primary": "acct-a" }, "claude")).toThrow(/claude-secondary/)
  })

  it("--move-alive selects only ALIVE sessions on the departing account (slot or literal), never dead ones", () => {
    const plan = planAccountSlotSwap({ "claude-primary": "acct-a", "claude-secondary": "acct-b" }, "claude")
    const picked = sessionsToMoveOnSwap(
      [
        session("via-slot", { profileRef: "acct-a", accessSlot: "claude-primary" }),
        session("literal", { profileRef: "acct-a" }),
        session("starting", { profileRef: "acct-a", status: "starting" }),
        session("dead-exited", { profileRef: "acct-a", status: "exited" }),
        session("dead-killed", { profileRef: "acct-a", accessSlot: "claude-primary", status: "killed" }),
        session("other-account", { profileRef: "acct-b", accessSlot: "claude-secondary" }),
        session("terminal", { profileRef: "acct-a", kind: "terminal" }),
      ],
      plan,
    )
    expect(picked.map(s => s.id)).toEqual(["via-slot", "literal", "starting"])
  })

  it("swap with moveAlive writes config.json and restarts only the alive sessions onto slot:<family>-primary", async () => {
    const restarted: Array<{ id: string; profileRef: string }> = []
    const result = await runAccountSlotSwap(
      {
        registry: {
          list: () => [
            session("alive", { profileRef: "acct-a", accessSlot: "claude-primary" }),
            session("dead", { profileRef: "acct-a", accessSlot: "claude-primary", status: "exited" }),
          ],
        },
        restartSession: async (prev, overrides) => {
          restarted.push({ id: prev.id, profileRef: overrides.access.profileRef })
          return { id: `${prev.id}-next` }
        },
      },
      { family: "claude", moveAlive: true },
    )
    expect(restarted).toEqual([{ id: "alive", profileRef: "slot:claude-primary" }])
    expect(result.moved).toEqual([{ from: "alive", to: "alive-next", label: "alive" }])
    const cfg = JSON.parse(await readFile(join(home, ".agentproto", "config.json"), "utf8"))
    expect(cfg.accountSlots).toMatchObject({ "claude-primary": "acct-b", "claude-secondary": "acct-a" })
    // The other slots of the map are kept as they were.
    expect(cfg.accountSlots["claude-dead"]).toBe("acct-off")
  })

  it("a dry run writes nothing and restarts nothing", async () => {
    let restarts = 0
    const result = await runAccountSlotSwap(
      {
        registry: { list: () => [session("alive", { profileRef: "acct-a" })] },
        restartSession: async prev => {
          restarts++
          return { id: prev.id }
        },
      },
      { family: "claude", moveAlive: true, dryRun: true },
    )
    expect(restarts).toBe(0)
    expect(result).toMatchObject({ dryRun: true, moved: [{ from: "alive" }] })
    const cfg = JSON.parse(await readFile(join(home, ".agentproto", "config.json"), "utf8"))
    expect(cfg.accountSlots["claude-primary"]).toBe("acct-a")
  })

  it("applyAccountSlotSwap refuses a plan made stale by a concurrent edit", async () => {
    const plan = planAccountSlotSwap({ "claude-primary": "acct-a", "claude-secondary": "acct-b" }, "claude")
    await writeSlots({ "claude-primary": "acct-b", "claude-secondary": "acct-b" })
    await expect(applyAccountSlotSwap(plan)).rejects.toThrow(/changed/)
  })

  it("accounts slots lists each slot with its alive sessions", async () => {
    const rows = await listAccountSlotRows(
      { "claude-primary": "acct-a", "claude-dead": "acct-off" },
      [
        session("s1", { profileRef: "acct-a", accessSlot: "claude-primary" }),
        session("s2", { profileRef: "acct-a" }),
        session("s3", { profileRef: "acct-a", accessSlot: "claude-primary", status: "exited" }),
      ],
    )
    expect(rows).toEqual([
      { slot: "claude-dead", profileRef: "acct-off", problem: "disabled", aliveSessions: [] },
      {
        slot: "claude-primary",
        profileRef: "acct-a",
        aliveSessions: [
          { id: "s1", label: "s1", via: "slot" },
          { id: "s2", label: "s2", via: "profile" },
        ],
      },
    ])
  })
})

describe("profileRef entries other than spawn / restart / fallback", () => {
  it("sandbox_exec.envProfiles accepts a slot (resolved to the real profile)", async () => {
    const out = await resolveEnvProfiles({ TOKEN: "slot:claude-primary" }, undefined, {
      getAuthProfile: async id => (id === "acct-a" ? { ...profile("acct-a"), credentialRef: "kc:a" } : undefined),
      secretStore: { read: async ({ path }: { path: string }) => (path === "kc:a" ? { value: "secret-a" } : null) } as never,
      loadAccountSlots: async () => ({ "claude-primary": "acct-a" }),
    })
    expect(out).toMatchObject({ ok: true, env: { TOKEN: "secret-a" } })
  })

  it("sandbox_exec.envProfiles: an unknown slot fails the call", async () => {
    const out = await resolveEnvProfiles({ TOKEN: "slot:nope" }, undefined, { loadAccountSlots: async () => ({}) })
    expect(out).toMatchObject({ ok: false, code: "profile_error" })
    if (!out.ok) expect(out.message).toMatch(/nope.*not defined/)
  })

  it("harness presets accept a slot: stored as the slot, validated against its profile", async () => {
    await addHarnessPreset(
      { id: "cc-slot", harnessSlug: "claude-code", name: "x", profileRef: "slot:claude-primary", defaultModel: "claude-sonnet-5-5", isDefault: false },
    )
    await expect(getHarnessPreset("cc-slot")).resolves.toMatchObject({ profileRef: "slot:claude-primary" })
    await expect(
      addHarnessPreset({ id: "cc-dead", harnessSlug: "claude-code", name: "x", profileRef: "slot:claude-dead", defaultModel: "m", isDefault: false }),
    ).rejects.toBeInstanceOf(HarnessPresetValidationError)
  })

  it("llm_endpoint_set_upstream_link refuses a slot explicitly", async () => {
    const tools = new Map<string, (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>()
    const server = { tool: (name: string, _d: string, _s: unknown, h: never) => tools.set(name, h) } as unknown as McpServer
    registerLlmEndpointTools(server, { registry: { status: async () => ({ running: false }) } as unknown as LlmEndpointRegistry })
    const out = await tools.get("llm_endpoint_set_upstream_link")!({ provider: "anthropic", profileId: "slot:claude-primary" })
    expect(out.isError).toBe(true)
    expect(out.content[0]!.text).toMatch(/account slot.*real auth-profile id/)
  })

  it("decision_* escalation resolves a slot target to the real profile before the spawn", async () => {
    const r = resolveExecProfile({ profile: "remote-sonnet" })
    if (!r.ok) throw new Error(r.error)
    const target = await resolveAndValidateTarget(
      r.profile,
      { adapter: "claude-code", model: "claude-sonnet-4-5", profileRef: "slot:claude-primary" },
      { getAuthProfile: async id => profile(id) as never, getDefaultHarnessPreset: async () => undefined },
    )
    expect(target).toMatchObject({ ok: true, profileRef: "acct-a", spawn: { access: { profileRef: "acct-a" } } })
    const bad = await resolveAndValidateTarget(
      r.profile,
      { adapter: "claude-code", model: "claude-sonnet-4-5", profileRef: "slot:nope" },
      { getAuthProfile: async id => profile(id) as never, getDefaultHarnessPreset: async () => undefined },
    )
    expect(bad).toMatchObject({ ok: false, code: "account_slot_unresolved" })
  })
})
