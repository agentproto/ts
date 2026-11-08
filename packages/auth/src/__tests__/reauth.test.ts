import { afterEach, describe, expect, it } from "vitest"
import {
  AuthReauthRequiredError,
  EXPIRING_WINDOW_MS,
  SubaccountError,
  deriveAuthState,
  findReauthAdapter,
  listReauthAdapters,
  profileAuthStatus,
  reauthCommand,
  reauthHintOf,
  registerReauthAdapter,
  unregisterReauthAdapter,
  type AuthProfile,
  type ParentAccountInfo,
  type ReauthAdapter,
} from "../index.js"

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

describe("deriveAuthState", () => {
  it("is unknown without a usable expiry", () => {
    expect(deriveAuthState(undefined, NOW)).toBe("unknown")
    expect(deriveAuthState(null, NOW)).toBe("unknown")
    expect(deriveAuthState(Number.NaN, NOW)).toBe("unknown")
  })
  it("is expired in the past and inside the 60s skew", () => {
    expect(deriveAuthState(NOW - 1, NOW)).toBe("expired")
    expect(deriveAuthState(NOW + 59_000, NOW)).toBe("expired")
  })
  it("is expiring inside the window, ok beyond it", () => {
    expect(deriveAuthState(NOW + 61_000, NOW)).toBe("expiring")
    expect(deriveAuthState(NOW + EXPIRING_WINDOW_MS, NOW)).toBe("expiring")
    expect(deriveAuthState(NOW + EXPIRING_WINDOW_MS + 1, NOW)).toBe("ok")
  })
})

describe("reauthCommand / reauthHintOf", () => {
  it("quotes only a target that needs it", () => {
    expect(reauthCommand("opencode-ws01")).toBe("agentproto auth reauth opencode-ws01")
    expect(reauthCommand("my profile")).toBe('agentproto auth reauth "my profile"')
  })
  it("reads the hint of a typed error", () => {
    const err = new AuthReauthRequiredError(
      { command: reauthCommand("p1"), source: "s", reason: "expired" },
      "log in again",
    )
    expect(err).toBeInstanceOf(SubaccountError)
    expect(err.code).toBe("auth_reauth_required")
    expect(reauthHintOf(err)).toEqual({ command: "agentproto auth reauth p1", source: "s", reason: "expired" })
  })
  it("duck-types a hint from another copy of the package", () => {
    const foreign = Object.assign(new Error("x"), { reauth: { command: "c", source: "s", reason: "missing" } })
    expect(reauthHintOf(foreign)?.command).toBe("c")
  })
  it("returns undefined for anything without a well-formed hint", () => {
    expect(reauthHintOf(new Error("x"))).toBeUndefined()
    expect(reauthHintOf(Object.assign(new Error("x"), { reauth: { command: 1 } }))).toBeUndefined()
    expect(reauthHintOf("nope")).toBeUndefined()
  })
})

describe("reauth adapter registry and profileAuthStatus", () => {
  const registered: string[] = []
  afterEach(() => {
    for (const s of registered.splice(0)) unregisterReauthAdapter(s)
  })

  const fake = (info: ParentAccountInfo | Error, over: Partial<ReauthAdapter> = {}): ReauthAdapter => ({
    source: "fake-src",
    aliases: ["fk"],
    displayName: "Fake",
    inspect: async () => {
      if (info instanceof Error) throw info
      return info
    },
    plan: () => ({ kind: "manual", instructions: "x" }),
    verify: async () => ({ status: "verified", checked: [], notChecked: [], problems: [], sideEffects: [] }),
    ...over,
  })
  const use = (a: ReauthAdapter) => {
    registerReauthAdapter(a)
    registered.push(a.source)
  }
  const profile: AuthProfile = { id: "p1", endpoint: "e", method: "api-key", source: "fake-src" }

  it("finds an adapter by source or alias, and replaces by source", () => {
    use(fake({ loggedIn: true }))
    expect(findReauthAdapter("fake-src")?.displayName).toBe("Fake")
    expect(findReauthAdapter("fk")?.source).toBe("fake-src")
    expect(findReauthAdapter("nope")).toBeUndefined()
    expect(findReauthAdapter(undefined)).toBeUndefined()
    use(fake({ loggedIn: true }, { displayName: "Second" }))
    expect(listReauthAdapters().filter(a => a.source === "fake-src")).toHaveLength(1)
    expect(findReauthAdapter("fk")?.displayName).toBe("Second")
  })

  it("derives state and ISO expiry from the parent, and never carries a token", async () => {
    use(fake({ loggedIn: true, id: "acc_1", label: "user1@example.test", expiresAtMs: NOW + 2 * HOUR, fingerprint: "ff" }))
    const st = await profileAuthStatus(profile, { now: NOW })
    expect(st).toEqual({
      expiresAt: new Date(NOW + 2 * HOUR).toISOString(),
      state: "expiring",
      parent: { source: "fake-src", id: "acc_1", label: "user1@example.test", loggedIn: true },
    })
  })

  it("a missing login reads expired; a self-refreshing parent reads unknown but keeps its expiry", async () => {
    use(fake({ loggedIn: false }))
    expect(await profileAuthStatus(profile, { now: NOW })).toMatchObject({ state: "expired", expiresAt: null })
    use(fake({ loggedIn: true, expiresAtMs: NOW - HOUR, selfRefreshing: true, note: "renews itself" }))
    expect(await profileAuthStatus(profile, { now: NOW })).toMatchObject({
      state: "unknown",
      expiresAt: new Date(NOW - HOUR).toISOString(),
      note: "renews itself",
    })
  })

  it("an unreadable parent is unknown with the reason, and a source without adapter is unknown", async () => {
    use(fake(new Error("db locked")))
    const st = await profileAuthStatus(profile, { now: NOW })
    expect(st.state).toBe("unknown")
    expect(st.note).toMatch(/db locked/)
    expect(await profileAuthStatus({ ...profile, source: "unregistered" })).toEqual({ expiresAt: null, state: "unknown" })
  })
})
