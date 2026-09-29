import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { toToolResult } from "@agentproto/tool"
import {
  assertNoOwnedArgs,
  assertSpawnArgsSafe,
  BROWSER_PROFILE_REFUSED_CODE,
  BrowserProfileRefusedError,
  defaultChromeUserDataDirs,
  isDefaultChromeUserDataDir,
  resolveDedicatedProfileDir,
} from "../profile.js"

const root = mkdtempSync(join(tmpdir(), "profile-guard-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const mac = { home: "/Users/tester", platform: "darwin" }
const linux = { home: "/home/tester", platform: "linux" }

function refusal(fn: () => unknown): BrowserProfileRefusedError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(BrowserProfileRefusedError)
    return err as BrowserProfileRefusedError
  }
  throw new Error("expected a browser:profile-refused error")
}

describe("default Chrome user-data-dir detection", () => {
  it("knows the per-OS default dirs", () => {
    expect(defaultChromeUserDataDirs(mac)).toContain("/Users/tester/Library/Application Support/Google/Chrome")
    expect(defaultChromeUserDataDirs(linux)).toContain("/home/tester/.config/google-chrome")
    expect(defaultChromeUserDataDirs({ home: "C:\\u", platform: "win32", localAppData: "C:\\L" }).length).toBeGreaterThan(0)
  })

  it("matches the dir itself and anything inside it, not siblings", () => {
    const chrome = "/Users/tester/Library/Application Support/Google/Chrome"
    expect(isDefaultChromeUserDataDir(chrome, mac)).toBe(true)
    expect(isDefaultChromeUserDataDir(`${chrome}/Profile 1`, mac)).toBe(true)
    expect(isDefaultChromeUserDataDir("/Users/tester/Library/Application Support/Google/ChromeX", mac)).toBe(false)
    expect(isDefaultChromeUserDataDir("/Users/tester/.agentproto/browser/profiles/main", mac)).toBe(false)
    expect(isDefaultChromeUserDataDir("/home/tester/.config/google-chrome/Default", linux)).toBe(true)
  })

  it("resolves symlinks that point into a default dir", () => {
    const fakeHome = join(root, "home")
    const chrome = join(fakeHome, ".config", "google-chrome")
    mkdirSync(chrome, { recursive: true })
    const link = join(root, "innocent-looking")
    symlinkSync(chrome, link)
    expect(isDefaultChromeUserDataDir(link, { home: fakeHome, platform: "linux" })).toBe(true)
  })
})

describe("resolveDedicatedProfileDir", () => {
  const base = { providerId: "chrome", dataDir: join(root, "data"), env: linux }

  it("builds a fresh dir under the provider data dir from profile, label, or main", () => {
    expect(resolveDedicatedProfileDir({ ...base, profile: "work" })).toBe(join(root, "data", "profiles", "work"))
    expect(resolveDedicatedProfileDir({ ...base, label: "conformance-core" })).toBe(join(root, "data", "profiles", "conformance-core"))
    expect(resolveDedicatedProfileDir(base)).toBe(join(root, "data", "profiles", "main"))
    expect(resolveDedicatedProfileDir({ ...base, profile: "a b@c" })).toBe(join(root, "data", "profiles", "a_b_c"))
  })

  it("refuses the default profile: names of real Chrome profiles", () => {
    for (const name of ["Default", "default", "Profile 3", "Profile_1"]) {
      const err = refusal(() => resolveDedicatedProfileDir({ ...base, profile: name }))
      expect(err.code).toBe(BROWSER_PROFILE_REFUSED_CODE)
      expect(err.reason).toBe("default-profile-name")
    }
  })

  it("refuses an explicit default user-data-dir, and a profile given as that path", () => {
    const chrome = "/home/tester/.config/google-chrome"
    expect(refusal(() => resolveDedicatedProfileDir({ ...base, userDataDir: chrome })).reason).toBe("default-user-data-dir")
    expect(refusal(() => resolveDedicatedProfileDir({ ...base, userDataDir: `${chrome}/Default` })).reason).toBe("default-user-data-dir")
    expect(refusal(() => resolveDedicatedProfileDir({ ...base, profile: chrome })).reason).toBe("default-user-data-dir")
    expect(refusal(() => resolveDedicatedProfileDir({ ...base, profile: "~/.config/google-chrome" })).reason).toBe("default-user-data-dir")
  })

  it("refuses a path as a profile name even when it is not a default dir", () => {
    expect(refusal(() => resolveDedicatedProfileDir({ ...base, profile: "/tmp/somewhere" })).reason).toBe("default-profile-name")
  })

  it("refuses fullProfile", () => {
    const err = refusal(() => resolveDedicatedProfileDir({ ...base, fullProfile: true }))
    expect(err.reason).toBe("full-profile")
    expect(err.message).toMatch(/136/)
  })

  it("allows an explicit non-default dedicated dir", () => {
    const dir = join(root, "mine")
    expect(resolveDedicatedProfileDir({ ...base, userDataDir: dir })).toBe(dir)
  })

  it("the error is a standard tool-error envelope with a stable code", () => {
    const err = refusal(() => resolveDedicatedProfileDir({ ...base, fullProfile: true }))
    const result = toToolResult(undefined, err)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(BROWSER_PROFILE_REFUSED_CODE)
      expect(result.error.cause).toMatchObject({ reason: "full-profile", providerId: "chrome" })
    }
  })
})

describe("argument guards", () => {
  it("refuses caller args that override the dir, the port, or ask for the full profile", () => {
    expect(refusal(() => assertNoOwnedArgs(["--user-data-dir=/x"], "chrome")).reason).toBe("arg-override")
    expect(refusal(() => assertNoOwnedArgs(["--remote-debugging-port=9222"], "chrome")).reason).toBe("arg-override")
    expect(refusal(() => assertNoOwnedArgs(["--full-profile"], "chrome")).reason).toBe("full-profile")
    expect(() => assertNoOwnedArgs(["--mute-audio", "--window-size=800,600"], "chrome")).not.toThrow()
  })

  it("the final spawn check needs exactly one non-default --user-data-dir", () => {
    const fresh = `--user-data-dir=${join(root, "fresh")}`
    expect(() => assertSpawnArgsSafe([fresh, "--remote-debugging-port=0"], "chrome", linux)).not.toThrow()
    expect(() => assertSpawnArgsSafe(["--remote-debugging-port=0"], "chrome", linux)).toThrow(BrowserProfileRefusedError)
    expect(() => assertSpawnArgsSafe([fresh, fresh], "chrome", linux)).toThrow(BrowserProfileRefusedError)
    expect(() =>
      assertSpawnArgsSafe(["--user-data-dir=/home/tester/.config/google-chrome"], "chrome", linux),
    ).toThrow(BrowserProfileRefusedError)
  })
})
