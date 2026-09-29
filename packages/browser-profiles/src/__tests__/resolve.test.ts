import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserDriver } from "@agentproto/driver-browser"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ChromeIdentityError,
  createAuthSignalRegistry,
  createSessionSourceRegistry,
  resolveSession,
  SessionResolveError,
  SessionSourceUnknownError,
  catalogSessionStore,
  type CamofoxSession,
  type OpenSessionOptions,
  type SessionCookie,
  type SessionDescriptor,
} from "../index.js"
import { makeSyntheticChromeRoot, SYNTH_PASSWORD, sqliteAvailable } from "./synthetic-chrome.js"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const fakeSession = { tabId: "t", userId: "u" } as unknown as CamofoxSession
const opener = () => {
  const calls: OpenSessionOptions[] = []
  const openCamofox = vi.fn(async (o: OpenSessionOptions) => {
    calls.push(o)
    return fakeSession
  })
  return { calls, openCamofox }
}
const ck = (name: string): SessionCookie => ({ name, value: "synthetic", domain: ".example.test", path: "/", secure: true, httpOnly: false })
const reg = createAuthSignalRegistry([{ domain: "example.test", cookieNames: ["sid"] }])
const soon = Math.floor(Date.now() / 1000) + 86_400

describe("resolveSession", () => {
  it("backend chrome returns the injected driver, and needs one", async () => {
    const driver = { id: "d" } as unknown as BrowserDriver
    const desc: SessionDescriptor = { id: "c", backend: "chrome" }
    expect(await resolveSession(desc, { driver })).toEqual({ backend: "chrome", driver })
    await expect(resolveSession(desc)).rejects.toBeInstanceOf(SessionResolveError)
  })

  it("prefers driverFor(profile) when the identity names a profile", async () => {
    const perProfile = { id: "p1" } as unknown as BrowserDriver
    const driverFor = vi.fn(async () => perProfile)
    const r = await resolveSession({ id: "c", backend: "chrome", identity: { profile: "Profile 1" } }, { driverFor })
    expect(driverFor).toHaveBeenCalledWith("Profile 1")
    expect(r).toEqual({ backend: "chrome", driver: perProfile })
  })

  it("registered source: materialises through the registry and injects those cookies", async () => {
    const { calls, openCamofox } = opener()
    const materialize = vi.fn(async () => [ck("a"), ck("a"), ck("b")])
    const sources = createSessionSourceRegistry([{ kind: "vault", materialize }])
    const desc: SessionDescriptor = {
      id: "s1",
      backend: "camofox",
      inject: { from: "vault", sessionRef: "ref-1", domains: ["example.test"] },
      url: "https://example.test/",
    }
    const r = await resolveSession(desc, { sources, openCamofox })
    expect(r.backend).toBe("camofox")
    expect(materialize).toHaveBeenCalledWith({ sessionRef: "ref-1", domains: ["example.test"] })
    expect(calls[0]).toMatchObject({ userId: "s1", injectCookies: true, keepAlive: true, url: "https://example.test/" })
    expect(calls[0]?.cookies?.map(c => c.name)).toEqual(["a", "b"])
  })

  it("an old guilde-shaped descriptor with no guilde source registered is a typed unknown-kind error", async () => {
    const { openCamofox } = opener()
    const desc: SessionDescriptor = {
      id: "g",
      backend: "camofox",
      inject: { from: "guilde", sessionRef: "ref-abc", domains: ["linkedin.com"] },
    }
    await expect(resolveSession(desc, { openCamofox })).rejects.toBeInstanceOf(SessionSourceUnknownError)
  })

  it("a source that returns nothing is a resolve error, not an empty session", async () => {
    const { openCamofox } = opener()
    const sources = createSessionSourceRegistry([{ kind: "vault", materialize: async () => [] }])
    const desc: SessionDescriptor = { id: "s", backend: "camofox", inject: { from: "vault", sessionRef: "r", domains: ["example.test"] } }
    await expect(resolveSession(desc, { sources, openCamofox })).rejects.toBeInstanceOf(SessionResolveError)
  })

  it("owned login (camofox-native) opens without injecting cookies", async () => {
    const { calls, openCamofox } = opener()
    await resolveSession({ id: "o", backend: "camofox", inject: { from: "camofox-native" }, base: "http://camofox.test" }, { openCamofox })
    expect(calls[0]).toMatchObject({ userId: "o", injectCookies: false, keepAlive: true, base: "http://camofox.test" })
    expect(calls[0]?.cookies).toBeUndefined()
  })

  it("file inject reads a synthetic cookie jar, domain-scoped, and injects it", async () => {
    const { calls, openCamofox } = opener()
    const d = mkdtempSync(join(tmpdir(), "bp-jar-"))
    dirs.push(d)
    const jar = join(d, "jar.json")
    writeFileSync(
      jar,
      JSON.stringify({
        cookies: [
          { name: "keep", value: "v", domain: ".example.test", path: "/" },
          { name: "drop", value: "v", domain: ".other.test", path: "/" },
        ],
      }),
    )
    await resolveSession({ id: "f", backend: "camofox", inject: { from: "file", domains: ["example.test"], path: jar } }, { openCamofox })
    expect(calls[0]?.cookies?.map(c => c.name)).toEqual(["keep"])
  })

  it("a camofox descriptor with no inject and no strategies is a resolve error", async () => {
    await expect(resolveSession({ id: "e", backend: "camofox" }, {})).rejects.toBeInstanceOf(SessionResolveError)
  })
})

describe.skipIf(!sqliteAvailable())("resolveSession from a synthetic Chrome profile", () => {
  const rootWith = (cookies: Array<{ host: string; name: string; value: string; expiresUnix?: number }>): string => {
    const r = makeSyntheticChromeRoot([{ dir: "Default", name: "Work", email: "w@example.test", cookies }])
    dirs.push(r)
    return r
  }
  const desc: SessionDescriptor = {
    id: "ch",
    backend: "camofox",
    identity: { profile: "Default", account: "w@example.test" },
    inject: { from: "chrome-profile", domains: ["example.test"], profile: "Default" },
  }

  it("gathers the domain's cookies and injects them", async () => {
    const { calls, openCamofox } = opener()
    const chromeRoot = rootWith([{ host: ".example.test", name: "sid", value: "v", expiresUnix: soon }])
    await resolveSession(desc, { openCamofox, authSignals: reg, local: { chromeRoot, safeStoragePassword: () => SYNTH_PASSWORD } })
    expect(calls[0]?.cookies?.map(c => c.name)).toEqual(["sid"])
    expect(calls[0]).toMatchObject({ injectCookies: true, keepAlive: true })
  })

  it("the identity guard refuses stale crumbs (no valid auth cookie) with a typed error", async () => {
    const { openCamofox } = opener()
    const chromeRoot = rootWith([{ host: ".example.test", name: "tracking", value: "v" }])
    await expect(
      resolveSession(desc, { openCamofox, authSignals: reg, local: { chromeRoot, safeStoragePassword: () => SYNTH_PASSWORD } }),
    ).rejects.toBeInstanceOf(ChromeIdentityError)
  })

  it("with no detector registered the domain is unknown: proceeds on presence and warns, never claims authed", async () => {
    const { openCamofox } = opener()
    const warn = vi.fn()
    const chromeRoot = rootWith([{ host: ".example.test", name: "sid", value: "v" }])
    await resolveSession(desc, { openCamofox, warn, local: { chromeRoot, safeStoragePassword: () => SYNTH_PASSWORD } })
    expect(warn.mock.calls.some(c => String(c[0]).includes("no auth signal registered"))).toBe(true)
  })

  it("warnings never contain cookie values", async () => {
    const { openCamofox } = opener()
    const warn = vi.fn()
    const chromeRoot = rootWith([{ host: ".example.test", name: "sid", value: "TOP-SECRET-VALUE" }])
    await resolveSession(desc, { openCamofox, warn, local: { chromeRoot, safeStoragePassword: () => SYNTH_PASSWORD } })
    expect(JSON.stringify(warn.mock.calls)).not.toContain("TOP-SECRET-VALUE")
  })
})

describe("catalogSessionStore", () => {
  const catalog = {
    list: async () => [{ ref: "r1", domains: ["example.test"], identity: { platform: "x" }, url: "https://example.test" }],
    get: async (ref: string) => (ref === "r1" ? { ref, domains: ["example.test"] } : null),
  }

  it("resolves catalog rows into from:<kind> descriptors and is read-only", async () => {
    const store = catalogSessionStore("vault", catalog)
    expect(await store.load("r1")).toEqual({
      id: "r1",
      backend: "camofox",
      inject: { from: "vault", sessionRef: "r1", domains: ["example.test"] },
    })
    expect(await store.load("nope")).toBeNull()
    expect((await store.list())[0]).toMatchObject({ id: "r1", identity: { platform: "x" }, url: "https://example.test" })
    await expect(store.save({ id: "x", backend: "camofox" })).rejects.toThrow(/read-only/)
    await expect(store.remove("r1")).rejects.toThrow(/read-only/)
  })
})
