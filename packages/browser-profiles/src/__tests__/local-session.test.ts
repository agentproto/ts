import { rmSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  countCookies,
  createAuthSignalRegistry,
  createLocalBrowserSession,
  decryptChromeValue,
  isKnown,
  profileDirs,
  safeStorageKey,
  scanChromeIdentities,
} from "../index.js"
import { encryptValue, makeSyntheticChromeRoot, SYNTH_PASSWORD, sqliteAvailable } from "./synthetic-chrome.js"

const roots: string[] = []
const synth = (...a: Parameters<typeof makeSyntheticChromeRoot>): string => {
  const r = makeSyntheticChromeRoot(...a)
  roots.push(r)
  return r
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

const soon = Math.floor(Date.now() / 1000) + 86_400

describe("decryptChromeValue", () => {
  it("round-trips a v10 value with a derived key, and passes plaintext through", () => {
    const key = safeStorageKey(SYNTH_PASSWORD)
    expect(decryptChromeValue(encryptValue("hello-cookie"), key)).toBe("hello-cookie")
    expect(decryptChromeValue(Buffer.from("plain").toString("hex"), key)).toBe("plain")
  })
})

describe.skipIf(!sqliteAvailable())("synthetic Chrome root", () => {
  const build = (): string =>
    synth(
      [
        {
          dir: "Default",
          name: "Work",
          email: "work@example.test",
          cookies: [
            { host: ".example.test", name: "sid", value: "secret-a", secure: true, httpOnly: true, expiresUnix: soon },
            { host: ".other.test", name: "x", value: "secret-b" },
          ],
        },
        { dir: "Profile 1", name: "Home", email: "home@example.test", cookies: [{ host: ".example.test", name: "sid", value: "secret-c" }] },
      ],
      "Profile 1",
    )

  it("lists profile dirs and counts cookies", () => {
    const root = build()
    expect(profileDirs(root).sort()).toEqual(["Default", "Profile 1"])
    expect(countCookies(join(root, "Default"))).toEqual({ known: 2 })
  })

  it("scan names identities from Local State and flags lastUsed", () => {
    const root = build()
    const reg = createAuthSignalRegistry([{ domain: "example.test", cookieNames: ["sid"] }])
    const ids = scanChromeIdentities({ chromeRoot: root, authSignals: reg })
    const d = ids.find(i => i.profile === "Default")
    expect(d).toMatchObject({ name: "Work", email: "work@example.test", lastUsed: false, cookieCount: 2 })
    expect(d?.domainsLoggedIn).toEqual(["example.test"])
    expect(d?.domainsAuthed).toEqual({ known: ["example.test"] })
    expect(ids.find(i => i.profile === "Profile 1")?.lastUsed).toBe(true)
  })

  it("decrypts only the requested domain, in memory, with an injected password", async () => {
    const root = build()
    const s = createLocalBrowserSession({ chromeRoot: root, safeStoragePassword: () => SYNTH_PASSWORD })
    const got = await s.getDecryptedForDomain("example.test", "Default")
    expect(got?.cookies).toHaveLength(1)
    expect(got?.cookies[0]).toMatchObject({ name: "sid", value: "secret-a", domain: ".example.test", secure: true, httpOnly: true, expires: soon })
    expect(await s.getDecryptedForDomain("nowhere.test", "Default")).toBeNull()
  })

  it("a wrong key never leaks garbage: undecryptable rows are dropped", async () => {
    const root = build()
    const s = createLocalBrowserSession({ chromeRoot: root, safeStoragePassword: () => "wrong-password" })
    expect(await s.getDecryptedForDomain("example.test", "Default")).toBeNull()
  })

  it("a failed read is Known unknown, never an empty result or zero", () => {
    const root = build()
    writeFileSync(join(root, "Default", "Cookies"), "this is not a sqlite database")
    const c = countCookies(join(root, "Default"))
    expect(isKnown(c)).toBe(false)
    const reg = createAuthSignalRegistry([{ domain: "example.test", cookieNames: ["sid"] }])
    const bad = scanChromeIdentities({ chromeRoot: root, authSignals: reg }).find(i => i.profile === "Default")
    expect(isKnown(bad?.domainsAuthed ?? { known: [] })).toBe(false)
    expect(bad?.cookieCount).toBe(0)
  })

  it("a missing Local State or Cookies DB yields no profiles instead of throwing", () => {
    const root = synth([])
    mkdirSync(join(root, "Default"))
    expect(profileDirs(root)).toEqual([])
    expect(scanChromeIdentities({ chromeRoot: root })).toEqual([])
  })
})
