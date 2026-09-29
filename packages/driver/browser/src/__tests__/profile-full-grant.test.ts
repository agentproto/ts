import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  assertNoOwnedArgs,
  BrowserProfileRefusedError,
  resolveDedicatedProfileDir,
  type FullProfileGrantProof,
} from "../profile.js"

const root = mkdtempSync(join(tmpdir(), "profile-full-grant-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const linux = { home: "/home/tester", platform: "linux" }
const base = { providerId: "chrome", dataDir: join(root, "data"), env: linux }

function proof(active: () => boolean): FullProfileGrantProof {
  return { grantId: "grant_1", isActive: active }
}

function reasonOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(BrowserProfileRefusedError)
    return (err as BrowserProfileRefusedError).reason
  }
  throw new Error("expected browser:profile-refused")
}

describe("fullProfile with a recorded grant (F11 unlock)", () => {
  it("is refused without a grant", () => {
    expect(reasonOf(() => resolveDedicatedProfileDir({ ...base, fullProfile: true }))).toBe("full-profile")
  })

  it("is unlocked by an active grant and still lands on a fresh dedicated dir", () => {
    const dir = resolveDedicatedProfileDir({ ...base, fullProfile: true, fullProfileGrant: proof(() => true) })
    expect(dir).toBe(join(root, "data", "profiles", "main"))
  })

  it("is refused again when the grant has been revoked (asked at every launch)", () => {
    let active = true
    const p = proof(() => active)
    expect(() => resolveDedicatedProfileDir({ ...base, fullProfile: true, fullProfileGrant: p })).not.toThrow()
    active = false
    expect(reasonOf(() => resolveDedicatedProfileDir({ ...base, fullProfile: true, fullProfileGrant: p }))).toBe("full-profile")
  })

  it("never lifts the default user-data-dir refusal", () => {
    const chrome = "/home/tester/.config/google-chrome"
    const p = proof(() => true)
    expect(reasonOf(() => resolveDedicatedProfileDir({ ...base, fullProfile: true, fullProfileGrant: p, userDataDir: chrome }))).toBe(
      "default-user-data-dir",
    )
    expect(reasonOf(() => resolveDedicatedProfileDir({ ...base, fullProfile: true, fullProfileGrant: p, profile: "Default" }))).toBe(
      "default-profile-name",
    )
  })

  it("a grant proof without the fullProfile request changes nothing", () => {
    expect(resolveDedicatedProfileDir({ ...base, fullProfileGrant: proof(() => true) })).toBe(join(root, "data", "profiles", "main"))
  })

  it("a raw --full-profile argument is refused even with an active grant", () => {
    expect(reasonOf(() => assertNoOwnedArgs(["--full-profile"], "chrome"))).toBe("full-profile")
  })
})
