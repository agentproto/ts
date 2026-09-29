import { readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const realLocalState = join(homedir(), "Library", "Application Support", "Google", "Chrome", "Local State")

describe("test-wide real-profile guard (setup.ts)", () => {
  it("blocks a sync read of a real Chrome path before any I/O", () => {
    expect(() => readFileSync(realLocalState, "utf8")).toThrow(/real browser profile path/)
  })
  it("blocks an async read of a real Chrome path", async () => {
    await expect(readFile(realLocalState, "utf8")).rejects.toThrow(/real browser profile path/)
  })
  it("blocks a sqlite3 invocation pointed at a real Chrome path", () => {
    expect(() => execFileSync("sqlite3", [join(homedir(), ".config", "google-chrome", "Default", "Cookies"), "select 1;"])).toThrow(
      /real browser profile path/,
    )
  })
  it("blocks the Keychain lookup", () => {
    expect(() => execFileSync("security", ["find-generic-password", "-wa", "Chrome", "-s", "Chrome Safe Storage"])).toThrow(/Keychain/)
  })
})
