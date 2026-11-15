/**
 * Account slotS (`accountSlots.<name>` as an ordered list): the first account
 * that is enabled, may run the model and is not exhausted wins; every account
 * spent is a typed `account_slot_exhausted` with the nearest return time and
 * never a spent account handed out anyway. A string slot behaves as before.
 *
 * Hermetic: injected slot map, profile lookup and health store (temp dir).
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AuthProfile } from "@agentproto/auth"
import {
  AccountSlotExhaustedError,
  AccountSlotError,
  accountSlotsOf,
  applyAccountSlotPrefer,
  carriedAccessSlot,
  listAccountSlotRows,
  planAccountSlotPrefer,
  planAccountSlotSwap,
  resolveAccessSlots,
  resolveProfileRef,
  sessionsToMoveOnPrefer,
  type AccountSlots,
} from "../account-slots.js"
import { createAccountHealthStore, type AccountHealthStore } from "../account-health.js"
import { validateConfig, validateConfigKeyValue } from "../config-schema.js"
import type { AgentprotoConfig } from "../config.js"

const T0 = Date.parse("2026-11-15T10:00:00Z")
const H = 3_600_000

type Profiles = Record<string, Pick<AuthProfile, "disabled" | "models">>

describe("account slots", () => {
  let dir: string
  let clock: number
  let health: AccountHealthStore
  let slots: AccountSlots
  let profiles: Profiles

  const deps = (extra: { model?: string } = {}) => ({
    loadAccountSlots: async () => slots,
    getAuthProfile: async (id: string) => profiles[id],
    accountHealth: health,
    ...extra,
  })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agp-slot-"))
    clock = T0
    health = createAccountHealthStore({ dir, now: () => clock })
    slots = {
      "opencode-go": ["ws01", "ws003", "hodl"],
      "claude-primary": "sub-a",
      "claude-secondary": "sub-b",
    }
    profiles = { ws01: {}, ws003: {}, hodl: {}, "sub-a": {}, "sub-b": {} }
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it("resolves to the first account of the slot and records the slot", async () => {
    expect(await resolveProfileRef("slot:opencode-go", deps())).toEqual({ profileRef: "ws01", slot: "opencode-go" })
  })

  it("skips an exhausted account, and takes it back by itself once its until has passed", async () => {
    await health.mark("ws01", { reason: "402", until: T0 + 2 * H, untilBasis: "observed" })
    expect((await resolveProfileRef("slot:opencode-go", deps())).profileRef).toBe("ws003")
    clock = T0 + 2 * H + 1 // renewal: no manual unblock needed
    expect((await resolveProfileRef("slot:opencode-go", deps())).profileRef).toBe("ws01")
  })

  it("skips missing and disabled accounts of a multi-account slot instead of failing", async () => {
    profiles.ws01 = { disabled: true }
    delete profiles.ws003
    expect((await resolveProfileRef("slot:opencode-go", deps())).profileRef).toBe("hodl")
  })

  it("skips an account whose model allow-list refuses the requested model", async () => {
    profiles.ws01 = { models: { mode: "allow", ids: ["glm-5.3"] } } as Pick<AuthProfile, "models">
    expect((await resolveProfileRef("slot:opencode-go", deps({ model: "deepseek-v4.1-flash" }))).profileRef).toBe("ws003")
    expect((await resolveProfileRef("slot:opencode-go", deps({ model: "glm-5.3" }))).profileRef).toBe("ws01")
  })

  it("every account exhausted: a typed account_slot_exhausted with the nearest retryAfter, never a spent account", async () => {
    await health.mark("ws01", { reason: "402", until: T0 + 30 * H, untilBasis: "observed" })
    await health.mark("ws003", { reason: "402", until: T0 + 5 * H, untilBasis: "observed" })
    await health.mark("hodl", { reason: "402", until: T0 + 9 * H, untilBasis: "observed" })
    const err = await resolveProfileRef("slot:opencode-go", deps()).catch(e => e)
    expect(err).toBeInstanceOf(AccountSlotExhaustedError)
    expect(err).toBeInstanceOf(AccountSlotError)
    expect(err.code).toBe("account_slot_exhausted")
    expect(err.retryAfter).toBe(new Date(T0 + 5 * H).toISOString())
    expect(err.accounts.map((a: { profileRef: string }) => a.profileRef).sort()).toEqual(["hodl", "ws003", "ws01"])
    expect(err.message).toMatch(/every account of the slot is exhausted/)
  })

  it("a single-account slot that is exhausted is refused too (a slot with one account)", async () => {
    await health.mark("sub-a", { reason: "limit", until: T0 + H, untilBasis: "observed" })
    await expect(resolveProfileRef("slot:claude-primary", deps())).rejects.toMatchObject({
      code: "account_slot_exhausted",
      retryAfter: new Date(T0 + H).toISOString(),
    })
    // the sibling slot is untouched
    expect((await resolveProfileRef("slot:claude-secondary", deps())).profileRef).toBe("sub-b")
  })

  it("a literal profile id is never blocked by health (only slots are)", async () => {
    await health.mark("ws01", { reason: "402" })
    expect(await resolveProfileRef("ws01", deps())).toEqual({ profileRef: "ws01" })
  })

  it("a single-account slot keeps its original errors (missing / disabled / unknown)", async () => {
    profiles["sub-a"] = { disabled: true }
    await expect(resolveProfileRef("slot:claude-primary", deps())).rejects.toMatchObject({
      code: "account_slot_profile_disabled",
    })
    delete profiles["sub-b"]
    await expect(resolveProfileRef("slot:claude-secondary", deps())).rejects.toMatchObject({
      code: "account_slot_profile_missing",
    })
    await expect(resolveProfileRef("slot:nope", deps())).rejects.toMatchObject({ code: "account_slot_unknown" })
  })

  it("a multi-account slot whose accounts are all disabled or missing says so (no silent fallback)", async () => {
    profiles.ws01 = { disabled: true }
    profiles.ws003 = { disabled: true }
    delete profiles.hodl
    await expect(resolveProfileRef("slot:opencode-go", deps())).rejects.toThrow(
      /no account of the slot is usable \(ws01: disabled; ws003: disabled; hodl: missing\)/,
    )
  })

  it("resolveAccessSlots records which slot account was billed", async () => {
    await health.mark("ws01", { reason: "402" })
    const r = await resolveAccessSlots({ profileRef: "slot:opencode-go" }, deps())
    expect(r.access.profileRef).toBe("ws003")
    expect(r.slotByProfile.get("ws003")).toBe("opencode-go")
  })

  it("accountSlotsOf accepts strings and non-empty string lists, drops anything else", () => {
    const cfg = {
      accountSlots: { a: "x", b: ["y", "z"], c: [], d: ["ok", 3], e: 5, f: "" },
    } as unknown as AgentprotoConfig
    expect(accountSlotsOf(cfg)).toEqual({ a: "x", b: ["y", "z"] })
  })

  it("a session stays on its slot while the slot still lists its account", async () => {
    const prev = { accessSlot: "opencode-go", accessProfile: { profileRef: "ws003" } }
    expect(await carriedAccessSlot(prev, deps())).toBe("opencode-go")
    expect(await carriedAccessSlot({ ...prev, accessProfile: { profileRef: "elsewhere" } }, deps())).toBeUndefined()
  })

  it("swap refuses a multi-account slot (it names one account per slot)", () => {
    slots = { ...slots, "opencode-go-primary": ["ws01", "ws003"], "opencode-go-secondary": "hodl" }
    expect(() => planAccountSlotSwap(slots, "opencode-go")).toThrow(/must each name ONE account/)
    expect(planAccountSlotSwap(slots, "claude").arriving).toBe("sub-b")
  })

  it("account_slots_list rows carry each account's health for a multi-account slot", async () => {
    await health.mark("ws01", { reason: "402", until: T0 + 4 * H, untilBasis: "observed" })
    const rows = await listAccountSlotRows(
      slots,
      [{ id: "s1", kind: "agent-cli", status: "running", accessSlot: "opencode-go", accessProfile: { profileRef: "ws003" } }],
      { getAuthProfile: async id => profiles[id], accountHealth: health },
    )
    const slot = rows.find(r => r.slot === "opencode-go")!
    expect(slot.profileRef).toBe("ws003") // where a spawn lands now
    expect(slot.accounts?.map(a => [a.profileRef, a.health?.state])).toEqual([
      ["ws01", "exhausted"],
      ["ws003", undefined],
      ["hodl", undefined],
    ])
    expect(slot.aliveSessions).toEqual([{ id: "s1", label: "s1", via: "slot" }])
    const single = rows.find(r => r.slot === "claude-primary")!
    expect(single.accounts).toBeUndefined()
  })

  describe("prefer", () => {
    it("puts the account at the head of the slot, the rest keep their order", () => {
      const plan = planAccountSlotPrefer(slots, "opencode-go", "hodl")
      expect(plan.departing).toBe("ws01")
      expect(plan.after["opencode-go"]).toEqual(["hodl", "ws01", "ws003"])
    })

    it("a profile outside the slot is added at the head; a slot ref is refused", () => {
      expect(planAccountSlotPrefer(slots, "opencode-go", "new").after["opencode-go"]).toEqual([
        "new",
        "ws01",
        "ws003",
        "hodl",
      ])
      expect(() => planAccountSlotPrefer(slots, "opencode-go", "slot:claude-primary")).toThrow(/slot lists real auth profiles/)
      expect(() => planAccountSlotPrefer(slots, "missing", "x")).toThrow(/not defined/)
    })

    it("selects the alive sessions that are not on the new head", () => {
      const plan = planAccountSlotPrefer(slots, "opencode-go", "hodl")
      const sessions = [
        { id: "a", kind: "agent-cli", status: "running", accessSlot: "opencode-go", accessProfile: { profileRef: "ws01" } },
        { id: "b", kind: "agent-cli", status: "running", accessSlot: "opencode-go", accessProfile: { profileRef: "hodl" } },
        { id: "c", kind: "agent-cli", status: "exited", accessSlot: "opencode-go", accessProfile: { profileRef: "ws01" } },
        { id: "d", kind: "agent-cli", status: "running", accessProfile: { profileRef: "ws003" } },
        { id: "e", kind: "agent-cli", status: "running", accessProfile: { profileRef: "elsewhere" } },
      ]
      expect(sessionsToMoveOnPrefer(sessions, plan).map(s => s.id)).toEqual(["a", "d"])
    })

    it("writes the new order to config.json", async () => {
      const { mkdir, writeFile, readFile } = await import("node:fs/promises")
      const path = join(dir, "config.json")
      await mkdir(dir, { recursive: true })
      await writeFile(path, JSON.stringify({ accountSlots: slots }))
      await applyAccountSlotPrefer(planAccountSlotPrefer(slots, "opencode-go", "ws003"), path)
      expect(JSON.parse(await readFile(path, "utf8")).accountSlots["opencode-go"]).toEqual(["ws003", "ws01", "hodl"])
    })
  })

  describe("config validation", () => {
    it("accepts a string and an ordered list, rejects a slot ref, an empty list and duplicates", () => {
      expect(validateConfig({ accountSlots: { a: "x", b: ["y", "z"] } }).ok).toBe(true)
      expect(validateConfig({ accountSlots: { a: ["slot:other"] } }).ok).toBe(false)
      expect(validateConfig({ accountSlots: { a: [] } }).ok).toBe(false)
      expect(validateConfig({ accountSlots: { a: ["x", "x"] } }).ok).toBe(false)
      expect(validateConfig({ accountSlots: { "a.b": ["x"] } }).ok).toBe(false)
      expect(validateConfigKeyValue("accountSlots", { go: ["ws01", "ws003"] }).ok).toBe(true)
      expect(validateConfigKeyValue("accountSlots.go", ["ws01", "ws003"]).ok).toBe(true)
    })
  })
})
