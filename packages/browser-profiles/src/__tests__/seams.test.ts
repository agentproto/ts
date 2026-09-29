import { describe, expect, it, vi } from "vitest"
import {
  AccountSwitcherMissingError,
  createAuthSignalRegistry,
  createSessionSourceRegistry,
  gatherCookies,
  SessionSourceDuplicateError,
  SessionSourceReservedError,
  SessionSourceUnknownError,
  type AuthCookieMeta,
  type SessionCookie,
  type SessionSource,
} from "../index.js"
import { makeSyntheticChromeRoot, SYNTH_PASSWORD, sqliteAvailable } from "./synthetic-chrome.js"

const NOW = Date.parse("2026-06-12T00:00:00.000Z")
const nowS = NOW / 1000
const meta = (name: string, host = "example.test", expiresUnix: number | undefined = nowS + 3600): AuthCookieMeta => ({
  name,
  host,
  expiresUnix,
})

describe("AuthSignalRegistry seam", () => {
  it("ships empty: nothing is known or authed until the host registers a detector", () => {
    const r = createAuthSignalRegistry()
    expect(r.knownDomains()).toEqual([])
    expect(r.isKnownDomain("example.test")).toBe(false)
    expect(r.isAuthed("example.test", [meta("sid")], NOW)).toBe(false)
  })

  it("consults a registered custom detector, passing only that domain's cookie metadata", () => {
    const detect = vi.fn((cookies: readonly AuthCookieMeta[]) => cookies.some(c => c.name === "session"))
    const r = createAuthSignalRegistry()
    r.register({ domain: "example.test", detect })
    expect(r.isAuthed("example.test", [meta("session"), meta("session", "other.test")], NOW)).toBe(true)
    expect(detect).toHaveBeenCalledTimes(1)
    expect(detect.mock.calls[0]?.[0]).toEqual([meta("session")])
    expect(r.isAuthed("example.test", [meta("tracking")], NOW)).toBe(false)
    expect(detect).toHaveBeenCalledTimes(2)
  })

  it("cookieNames rule: unexpired counts, expired does not, session cookie counts", () => {
    const r = createAuthSignalRegistry([{ domain: "example.test", cookieNames: ["sid"] }])
    expect(r.isAuthed("example.test", [meta("sid")], NOW)).toBe(true)
    expect(r.isAuthed("example.test", [meta("sid", "example.test", nowS - 10)], NOW)).toBe(false)
    expect(r.isAuthed("example.test", [meta("sid", "example.test", undefined)], NOW)).toBe(true)
  })

  it("resolves aliases and subdomains onto the registered domain", () => {
    const r = createAuthSignalRegistry([{ domain: "new.test", aliases: ["old.test"], cookieNames: ["sid"] }])
    expect(r.canonicalDomain(".OLD.test")).toBe("new.test")
    expect(r.equivalentDomains("new.test")).toEqual(["old.test"])
    expect(r.hostBelongsTo("www.old.test", "new.test")).toBe(true)
    expect(r.hostBelongsTo("evilold.test", "new.test")).toBe(false)
    expect(r.isAuthed("new.test", [meta("sid", "old.test")], NOW)).toBe(true)
  })

  it("is consulted by the Chrome scan (profile authed list follows the registered detector)", async () => {
    if (!sqliteAvailable()) return
    const { scanChromeIdentities } = await import("../local-session.js")
    const root = makeSyntheticChromeRoot([
      { dir: "Default", name: "A", cookies: [{ host: ".example.test", name: "sid", value: "v", expiresUnix: nowS + 99999 }] },
    ])
    const detect = vi.fn(() => true)
    const withDetector = createAuthSignalRegistry([{ domain: "example.test", detect }])
    const [id] = scanChromeIdentities({ chromeRoot: root, authSignals: withDetector })
    expect(detect).toHaveBeenCalled()
    expect(id?.domainsAuthed).toEqual({ known: ["example.test"] })
    const [none] = scanChromeIdentities({ chromeRoot: root, authSignals: createAuthSignalRegistry() })
    expect(none?.domainsAuthed).toEqual({ known: [] })
  })
})

describe("accountSwitcher seam", () => {
  const ck = (name: string): SessionCookie => ({ name, value: "x", domain: "example.test", path: "/", secure: true, httpOnly: false })

  it.skipIf(!sqliteAvailable())("is not called when no account is pinned", async () => {
    const root = makeSyntheticChromeRoot([{ dir: "Default", cookies: [{ host: ".example.test", name: "sid", value: "v" }] }])
    const accountSwitcher = vi.fn((_p: string, jar: SessionCookie[]) => jar)
    const jar = await gatherCookies(
      { from: "chrome-profile", domains: ["example.test"], profile: "Default" },
      { local: { chromeRoot: root, safeStoragePassword: () => SYNTH_PASSWORD }, accountSwitcher },
    )
    expect(jar.map(c => c.name)).toEqual(["sid"])
    expect(accountSwitcher).not.toHaveBeenCalled()
  })

  it.skipIf(!sqliteAvailable())("is called with platform, jar and userId when an account is pinned and a hook is provided", async () => {
    const root = makeSyntheticChromeRoot([{ dir: "Default", cookies: [{ host: ".example.test", name: "sid", value: "v" }] }])
    const accountSwitcher = vi.fn((_p: string, jar: SessionCookie[], _u: string) => [...jar, ck("switched")])
    const jar = await gatherCookies(
      { from: "chrome-profile", domains: ["example.test"], profile: "Default", account: { platform: "example", userId: "42" } },
      { local: { chromeRoot: root, safeStoragePassword: () => SYNTH_PASSWORD }, accountSwitcher },
    )
    expect(accountSwitcher).toHaveBeenCalledTimes(1)
    expect(accountSwitcher.mock.calls[0]?.[0]).toBe("example")
    expect(accountSwitcher.mock.calls[0]?.[2]).toBe("42")
    expect(jar.map(c => c.name)).toEqual(["sid", "switched"])
  })

  it.skipIf(!sqliteAvailable())("a pinned account with no hook is a typed error, not a silent default-account read", async () => {
    const root = makeSyntheticChromeRoot([{ dir: "Default", cookies: [{ host: ".example.test", name: "sid", value: "v" }] }])
    await expect(
      gatherCookies(
        { from: "chrome-profile", domains: ["example.test"], profile: "Default", account: { platform: "example", userId: "42" } },
        { local: { chromeRoot: root, safeStoragePassword: () => SYNTH_PASSWORD } },
      ),
    ).rejects.toBeInstanceOf(AccountSwitcherMissingError)
  })
})

describe("SessionSource registry seam", () => {
  const source = (kind: string, cookies: SessionCookie[] = []): SessionSource => ({
    kind,
    materialize: vi.fn(async () => cookies),
  })

  it("registers, lists and resolves by kind", async () => {
    const r = createSessionSourceRegistry()
    const a = source("vault")
    const b = source("bridge")
    r.register(a)
    r.register(b)
    expect(r.list().map(s => s.kind)).toEqual(["vault", "bridge"])
    expect(r.has("vault")).toBe(true)
    expect(r.has("nope")).toBe(false)
    expect(r.resolve("bridge")).toBe(b)
    const ref = { sessionRef: "r1", domains: ["example.test"] }
    await r.materialize("vault", ref)
    expect(a.materialize).toHaveBeenCalledWith(ref)
  })

  it("an unknown kind is a typed error naming the kind and what is registered", () => {
    const r = createSessionSourceRegistry([source("vault")])
    let caught: unknown
    try {
      r.resolve("guilde")
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SessionSourceUnknownError)
    const err = caught as SessionSourceUnknownError
    expect(err.code).toBe("browser-profiles:unknown-source")
    expect(err.kind).toBe("guilde")
    expect(err.registered).toEqual(["vault"])
    expect(() => r.materialize("guilde", { sessionRef: "x", domains: [] })).toThrow(SessionSourceUnknownError)
  })

  it("rejects a duplicate kind and any built-in kind", () => {
    const r = createSessionSourceRegistry([source("vault")])
    expect(() => r.register(source("vault"))).toThrow(SessionSourceDuplicateError)
    for (const k of ["chrome-cookie", "authed-storageState", "stored-credential", "chrome-profile", "file", "camofox-native"]) {
      expect(() => r.register(source(k))).toThrow(SessionSourceReservedError)
    }
  })
})
