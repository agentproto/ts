import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { BrowserProfileRefusedError, defaultChromeUserDataDirs, type BrowserCookie } from "@agentproto/driver-browser"
import { createChromiumProvider } from "../index.js"

const dataDir = mkdtempSync(join(tmpdir(), "chromium-grants-"))
afterAll(() => rmSync(dataDir, { recursive: true, force: true }))

const SECRET = "granted-chromium-cookie-value-42"
const STOP = "stop-after-addCookies"

interface Recorder {
  launched: string[]
  added: Array<Array<{ name: string; value: string; domain: string }>>
}

function fakeProvider(rec: Recorder, cookieSource?: (r: { providerId: string; profile: string }) => readonly BrowserCookie[]) {
  return createChromiumProvider({
    dataDir,
    ...(cookieSource ? { cookieSource } : {}),
    loadPlaywright: async () => ({
      chromium: {
        executablePath: () => "/nonexistent",
        launchPersistentContext: async (userDataDir: string) => {
          rec.launched.push(userDataDir)
          writeFileSync(join(userDataDir, "DevToolsActivePort"), "45679\n/devtools/browser/fake\n")
          return {
            on: () => undefined,
            close: async () => undefined,
            addCookies: async (c: Array<{ name: string; value: string; domain: string }>) => {
              rec.added.push(c)
            },
            newPage: async () => {
              throw new Error(STOP)
            },
          } as never
        },
      },
    }),
  })
}

describe("full-profile unlock (fake playwright, no browser)", () => {
  const proof = (active: boolean) => ({ grantId: "grant_1", isActive: () => active })

  it("refuses fullProfile without a grant or with an inactive one, before loading playwright", async () => {
    const rec: Recorder = { launched: [], added: [] }
    const provider = fakeProvider(rec)
    await expect(provider.launch({ label: "fp", fullProfile: true }, {})).rejects.toBeInstanceOf(BrowserProfileRefusedError)
    await expect(provider.launch({ label: "fp", fullProfile: true, fullProfileGrant: proof(false) }, {})).rejects.toBeInstanceOf(
      BrowserProfileRefusedError,
    )
    expect(rec.launched).toEqual([])
  })

  it("launches on a fresh dedicated dir with an active grant", async () => {
    const rec: Recorder = { launched: [], added: [] }
    const inst = await fakeProvider(rec).launch({ label: "fp-ok", fullProfile: true, fullProfileGrant: proof(true) }, {})
    expect(rec.launched).toHaveLength(1)
    expect(rec.launched[0]).toContain(join("profiles", "fp-ok"))
    await inst.stop()
  })

  it("still refuses the default user-data-dir with an active grant", async () => {
    const rec: Recorder = { launched: [], added: [] }
    const real = defaultChromeUserDataDirs()[0] as string
    const err = await fakeProvider(rec)
      .launch({ label: "x", fullProfile: true, fullProfileGrant: proof(true), userDataDir: real }, {})
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrowserProfileRefusedError)
    expect((err as BrowserProfileRefusedError).reason).toBe("default-user-data-dir")
    expect(rec.launched).toEqual([])
  })
})

describe("grant-backed cookie source", () => {
  it("adds exactly what the source returns, keyed by providerId and the profile label", async () => {
    const rec: Recorder = { launched: [], added: [] }
    const seen: Array<{ providerId: string; profile: string }> = []
    const provider = fakeProvider(rec, req => {
      seen.push(req)
      return [{ name: "sid", value: SECRET, domain: "github.com", path: "/" }]
    })
    const inst = await provider.launch({ label: "s1" }, {})
    await expect(inst.attach()).rejects.toThrow(STOP)
    expect(seen).toEqual([{ providerId: "chromium", profile: "s1" }])
    expect(rec.added).toHaveLength(1)
    expect(rec.added[0]?.map(c => c.name)).toEqual(["sid"])
    expect(rec.added[0]?.[0]?.value).toBe(SECRET)
    await inst.stop()
  })

  it("adds nothing when the source has no granted cookies", async () => {
    const rec: Recorder = { launched: [], added: [] }
    const inst = await fakeProvider(rec, () => []).launch({ label: "s2" }, {})
    await expect(inst.attach()).rejects.toThrow(STOP)
    expect(rec.added).toEqual([])
    await inst.stop()
  })
})
