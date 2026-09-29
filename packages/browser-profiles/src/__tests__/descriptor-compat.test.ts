/**
 * Backward compatibility: descriptors written by the earlier studio code must
 * load unchanged. Every fixture below is HAND-BUILT text in the exact shape the
 * old writer emitted (`JSON.stringify(desc, null, 2)` of the object literal the
 * named studio function produced, key order included). Nothing here is read from
 * a real machine.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  buildOwnedSessionDescriptor,
  cookieFreshness,
  fileSessionStore,
  injectFromOf,
  injectKindOf,
  normalizeDescriptor,
  parseSessionDescriptor,
  resolveInjectFromStrategies,
  selectResolutionStrategy,
  SessionDescriptorInvalidError,
  type SessionDescriptor,
} from "../index.js"

const PROFILES_DIR = "/synthetic/camofox-profiles"
const json = (o: unknown): string => JSON.stringify(o, null, 2)

/** Mirrors: `bureau session save` before V2 (studio `fileSessionStore.save` of a chrome-profile inject, identity from scanChromeIdentities). */
const LEGACY_CHROME_PROFILE = json({
  id: "x-jeremy",
  backend: "camofox",
  identity: {
    profile: "Profile 1",
    account: "jeremy@example.test",
    platform: "x",
    profileName: "Agentik",
    profileEmail: "jeremy@example.test",
  },
  inject: {
    from: "chrome-profile",
    domains: ["x.com", "twitter.com"],
    profile: "Profile 1",
    account: { platform: "x", userId: "1234567890" },
  },
  base: "http://localhost:9377",
  url: "https://x.com/home",
  savedAt: "2026-06-01T10:00:00.000Z",
})

/** Mirrors: the `file` inject variant of the same writer (a cookie-jar file, no Chrome dir). */
const LEGACY_FILE = json({
  id: "vinted-jar",
  backend: "camofox",
  inject: { from: "file", domains: ["vinted.fr"], path: "/synthetic/jars/vinted.json" },
  url: "https://www.vinted.fr",
  savedAt: "2026-05-20T08:30:00.000Z",
})

/** Mirrors: the pre-P3 `bureau session login` writer (camofox-native, owns its login, no strategies). */
const LEGACY_NATIVE = json({
  id: "linkedin-perso",
  backend: "camofox",
  identity: { platform: "linkedin", account: "jeremy@example.test" },
  inject: { from: "camofox-native" },
  base: "http://localhost:9377",
  savedAt: "2026-06-05T12:00:00.000Z",
})

/** Mirrors: studio `guildeSessionStore` `metaToDescriptor` (the managed-catalog shape; `from:"guilde"` is a registered source kind now). */
const LEGACY_GUILDE = json({
  id: "ref-abc123",
  backend: "camofox",
  identity: { account: "team@example.test", platform: "linkedin" },
  inject: { from: "guilde", sessionRef: "ref-abc123", domains: ["linkedin.com"] },
  url: "https://www.linkedin.com/feed/",
})

/** Mirrors: studio `buildOwnedSessionDescriptor` (V2, P3) with chrome provenance preserved from a prior chrome-profile descriptor. */
const V2_OWNED_WITH_CHROME = json({
  id: "x-jeremy",
  backend: "camofox",
  identity: {
    platform: "x",
    account: "jeremy",
    profile: "Profile 1",
    profileName: "Agentik",
    profileEmail: "jeremy@example.test",
  },
  inject: { from: "camofox-native" },
  base: "http://localhost:9377",
  savedAt: "2026-06-10T09:00:00.000Z",
  strategies: [
    {
      kind: "chrome-cookie",
      domains: ["x.com", "twitter.com"],
      profile: "Profile 1",
      profileName: "Agentik",
      profileEmail: "jeremy@example.test",
      account: { platform: "x", userId: "1234567890" },
    },
    {
      kind: "authed-storageState",
      storageStatePath: `${PROFILES_DIR}/x-jeremy.json`,
      capturedAt: "2026-06-10T09:00:00.000Z",
    },
    { kind: "stored-credential", platform: "x", account: "jeremy" },
  ],
  url: "https://x.com/home",
})

/** Mirrors: a `backend:"chrome"` descriptor (own logged-in browser over a driver) after `health` write-back stamped the probe fields. */
const V2_CHROME_BACKEND_PROBED = json({
  id: "drive-agentik-x",
  backend: "chrome",
  identity: { profile: "Profile 1", account: "jeremy@example.test", platform: "x" },
  savedAt: "2026-06-11T09:00:00.000Z",
  lastVerifiedAt: "2026-06-12T09:00:00.000Z",
  lastAuthStatus: "authenticated",
  lastCookieRefreshAt: "2026-06-12T09:00:00.000Z",
})

const ALL: Array<[string, string]> = [
  ["legacy chrome-profile inject", LEGACY_CHROME_PROFILE],
  ["legacy file inject", LEGACY_FILE],
  ["legacy camofox-native", LEGACY_NATIVE],
  ["legacy guilde-shaped source inject", LEGACY_GUILDE],
  ["V2 owned with chrome provenance", V2_OWNED_WITH_CHROME],
  ["V2 chrome backend with probe stamps", V2_CHROME_BACKEND_PROBED],
]

let dir: string
let prevProfilesDir: string | undefined

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bp-compat-"))
  prevProfilesDir = process.env["CAMOFOX_PROFILES_DIR"]
  process.env["CAMOFOX_PROFILES_DIR"] = PROFILES_DIR
})
afterAll(() => {
  if (prevProfilesDir === undefined) delete process.env["CAMOFOX_PROFILES_DIR"]
  else process.env["CAMOFOX_PROFILES_DIR"] = prevProfilesDir
  rmSync(dir, { recursive: true, force: true })
})

describe("old-code descriptors load unchanged", () => {
  it.each(ALL)("%s: parse returns the document as written, byte-stable on re-serialise", (_name, text) => {
    const parsed = parseSessionDescriptor(JSON.parse(text))
    expect(parsed).toEqual(JSON.parse(text))
    expect(json(parsed)).toBe(text)
  })

  it.each(ALL)("%s: fileSessionStore.load keeps every persisted field", async (_name, text) => {
    const original = JSON.parse(text) as SessionDescriptor
    writeFileSync(join(dir, `${original.id}.json`), text)
    const loaded = await fileSessionStore(dir).load(original.id)
    expect(loaded).toMatchObject(original)
  })

  it("V2 descriptors (strategies present) load structurally equal and re-save to identical bytes", async () => {
    for (const text of [V2_OWNED_WITH_CHROME, V2_CHROME_BACKEND_PROBED]) {
      const original = JSON.parse(text) as SessionDescriptor
      const store = fileSessionStore(dir)
      writeFileSync(join(dir, `${original.id}.json`), text)
      const loaded = await store.load(original.id)
      if (loaded?.strategies) expect(loaded).toEqual(original)
      expect(loaded).not.toBeNull()
      await store.save(loaded as SessionDescriptor)
      expect(readFileSync(join(dir, `${original.id}.json`), "utf8")).toBe(text)
    }
  })

  it("legacy chrome-profile inject derives the same chrome-cookie strategy the old normalizeDescriptor did", async () => {
    const original = JSON.parse(LEGACY_CHROME_PROFILE) as SessionDescriptor
    writeFileSync(join(dir, "x-jeremy.json"), LEGACY_CHROME_PROFILE)
    const loaded = await fileSessionStore(dir).load("x-jeremy")
    expect(loaded?.strategies).toEqual([
      {
        kind: "chrome-cookie",
        domains: ["x.com", "twitter.com"],
        profile: "Profile 1",
        profileName: "Agentik",
        profileEmail: "jeremy@example.test",
        account: { platform: "x", userId: "1234567890" },
      },
    ])
    expect(loaded?.inject).toEqual(original.inject)
  })

  it("legacy file inject collapses onto chrome-cookie with an empty profile, as before", () => {
    const d = normalizeDescriptor(JSON.parse(LEGACY_FILE) as SessionDescriptor)
    expect(d.strategies).toEqual([{ kind: "chrome-cookie", domains: ["vinted.fr"], profile: "" }])
    expect(resolveInjectFromStrategies(d)).toEqual(d.inject)
  })

  it("legacy camofox-native derives the owned storageState path", () => {
    const d = normalizeDescriptor(JSON.parse(LEGACY_NATIVE) as SessionDescriptor)
    expect(d.strategies).toEqual([{ kind: "authed-storageState", storageStatePath: `${PROFILES_DIR}/linkedin-perso.json` }])
  })

  it("legacy guilde-shaped inject becomes a source strategy of the same kind", () => {
    const d = normalizeDescriptor(JSON.parse(LEGACY_GUILDE) as SessionDescriptor)
    expect(d.strategies).toEqual([{ kind: "guilde", domains: ["linkedin.com"], sessionRef: "ref-abc123" }])
    expect(resolveInjectFromStrategies(d)).toEqual({ from: "guilde", domains: ["linkedin.com"], sessionRef: "ref-abc123" })
  })

  it("a stored credential match synthesizes the recovery strategy (credential index only, never secrets)", () => {
    const d = normalizeDescriptor(JSON.parse(LEGACY_NATIVE) as SessionDescriptor, {
      credentials: [{ platform: "linkedin", account: "jeremy@example.test" }],
    })
    expect(d.strategies?.map(s => s.kind)).toEqual(["authed-storageState", "stored-credential"])
  })
})

describe("writer parity", () => {
  it("buildOwnedSessionDescriptor reproduces the V2 fixture byte for byte", () => {
    const prev = normalizeDescriptor(JSON.parse(LEGACY_CHROME_PROFILE) as SessionDescriptor)
    const built = buildOwnedSessionDescriptor({
      id: "x-jeremy",
      platform: "x",
      reuseBase: "http://localhost:9377",
      account: "jeremy",
      url: "https://x.com/home",
      now: "2026-06-10T09:00:00.000Z",
      prev,
    })
    expect(json(built)).toBe(V2_OWNED_WITH_CHROME)
  })

  it("fileSessionStore writes 0700 dir / 0600 file with 2-space JSON", async () => {
    const fresh = join(dir, "fresh-store")
    const store = fileSessionStore(fresh)
    const d = JSON.parse(V2_CHROME_BACKEND_PROBED) as SessionDescriptor
    await store.save(d)
    expect(statSync(fresh).mode & 0o777).toBe(0o700)
    expect(statSync(join(fresh, `${d.id}.json`)).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(fresh, `${d.id}.json`), "utf8")).toBe(V2_CHROME_BACKEND_PROBED)
  })
})

describe("unknown keys and bad shapes", () => {
  it("keeps unknown keys a newer writer added (loose schemas)", () => {
    const doc = { ...JSON.parse(LEGACY_NATIVE), futureField: { a: 1 } }
    expect(parseSessionDescriptor(doc)).toEqual(doc)
  })

  it("rejects a document that is not a descriptor with a typed error", () => {
    expect(() => parseSessionDescriptor({ backend: "camofox" })).toThrow(SessionDescriptorInvalidError)
    expect(() => parseSessionDescriptor({ id: "x", backend: "firefox" })).toThrow(/backend/)
  })

  it("store.load returns null for a corrupt or foreign file, and list skips it", async () => {
    const d2 = mkdtempSync(join(tmpdir(), "bp-compat-bad-"))
    try {
      writeFileSync(join(d2, "junk.json"), "{not json")
      writeFileSync(join(d2, "foreign.json"), json({ hello: "world" }))
      writeFileSync(join(d2, "ok.json"), LEGACY_NATIVE.replace("linkedin-perso", "ok"))
      const store = fileSessionStore(d2)
      expect(await store.load("junk")).toBeNull()
      expect(await store.load("foreign")).toBeNull()
      expect((await store.list()).map(x => x.id)).toEqual(["ok"])
    } finally {
      rmSync(d2, { recursive: true, force: true })
    }
  })
})

describe("strategy selection, mapping and freshness (ported semantics)", () => {
  const v2 = JSON.parse(V2_OWNED_WITH_CHROME) as SessionDescriptor

  it("prefers the owned login, falls back to chrome-cookie after an auth wall", () => {
    expect(selectResolutionStrategy(v2)?.kind).toBe("authed-storageState")
    expect(selectResolutionStrategy({ ...v2, lastAuthStatus: "auth-wall" })?.kind).toBe("chrome-cookie")
  })

  it("never selects a stored-credential", () => {
    const only: SessionDescriptor = { id: "c", backend: "camofox", strategies: [{ kind: "stored-credential", platform: "x", account: "a" }] }
    expect(selectResolutionStrategy(only)).toBeUndefined()
  })

  it("maps inject.from and strategy kind both ways", () => {
    expect(injectKindOf("chrome-profile")).toBe("chrome-cookie")
    expect(injectKindOf("file")).toBe("chrome-cookie")
    expect(injectKindOf("camofox-native")).toBe("authed-storageState")
    expect(injectKindOf("guilde")).toBe("guilde")
    expect(injectFromOf("chrome-cookie")).toBe("chrome-profile")
    expect(injectFromOf("stored-credential")).toBeUndefined()
    expect(injectFromOf("guilde")).toBe("guilde")
  })

  it("cookieFreshness: chrome sources are fresh, owned ones go by the 7-day TTL", () => {
    const now = Date.parse("2026-06-12T00:00:00.000Z")
    const chromeOnly: SessionDescriptor = {
      id: "c",
      backend: "camofox",
      strategies: [{ kind: "chrome-cookie", domains: ["x.com"], profile: "Default" }],
    }
    expect(cookieFreshness(chromeOnly, now)).toBe("fresh")
    expect(cookieFreshness(v2, now)).toBe("unknown")
    expect(cookieFreshness({ ...v2, lastCookieRefreshAt: "2026-06-10T00:00:00.000Z" }, now)).toBe("fresh")
    expect(cookieFreshness({ ...v2, lastCookieRefreshAt: "2026-05-01T00:00:00.000Z" }, now)).toBe("stale")
  })
})
