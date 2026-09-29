import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { BrowserProfileRefusedError } from "@agentproto/driver-browser"
import { assertChromeLaunchDirSafe, chromeUserDataDir } from "../index.js"

// HOME points at a temp dir, so the kit's "default Chrome dir" for this test is a synthetic path.
let fakeHome: string
let prevHome: string | undefined

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "bp-home-"))
  prevHome = process.env["HOME"]
  process.env["HOME"] = fakeHome
})
afterEach(() => {
  if (prevHome === undefined) delete process.env["HOME"]
  else process.env["HOME"] = prevHome
  rmSync(fakeHome, { recursive: true, force: true })
})

describe("F11: launching against a default Chrome dir is refused by the kit", () => {
  it("refuses the default user-data-dir with browser:profile-refused", () => {
    let caught: unknown
    try {
      assertChromeLaunchDirSafe(chromeUserDataDir(fakeHome), "chrome")
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(BrowserProfileRefusedError)
    expect((caught as BrowserProfileRefusedError).code).toBe("browser:profile-refused")
  })

  it("allows a dedicated temp dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "bp-launch-"))
    try {
      expect(() => assertChromeLaunchDirSafe(dir, "chrome")).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
