/**
 * npm global-prefix detection — the cold-start fix for a CLI installed with
 * `npm i -g --prefix <dir>` (the no-sudo Linux path from install.sh).
 *
 * Without pinning, a later `npm i -g <adapter>` lands in npm's DEFAULT
 * prefix while the CLI lives under `<dir>`; `resolveAdapter` walks up from
 * the CLI and cannot see it ("installed but could not be loaded").
 */

import { describe, expect, it } from "vitest"
import {
  npmGlobalPrefixFromEntry,
  withNpmGlobalPrefix,
} from "../util/npm-prefix.js"

describe("npmGlobalPrefixFromEntry", () => {
  it("derives a POSIX global prefix from <prefix>/lib/node_modules", () => {
    expect(
      npmGlobalPrefixFromEntry(
        "/home/dev/.local/lib/node_modules/@agentproto/cli/dist/cli.mjs",
        "linux",
      ),
    ).toBe("/home/dev/.local")
    expect(
      npmGlobalPrefixFromEntry(
        "/opt/homebrew/lib/node_modules/@agentproto/cli/dist/cli.mjs",
        "darwin",
      ),
    ).toBe("/opt/homebrew")
  })

  it("derives a Windows global prefix from <prefix>/node_modules", () => {
    expect(
      npmGlobalPrefixFromEntry(
        "C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@agentproto\\cli\\dist\\cli.mjs",
        "win32",
      ),
    ).toBe("C:/Users/dev/AppData/Roaming/npm")
  })

  it("returns undefined for a repo-local install", () => {
    expect(
      npmGlobalPrefixFromEntry(
        "/code/app/node_modules/@agentproto/cli/dist/cli.mjs",
        "linux",
      ),
    ).toBeUndefined()
  })

  it("returns undefined for a pnpm virtual-store path", () => {
    expect(
      npmGlobalPrefixFromEntry(
        "/home/dev/.local/share/pnpm/global/5/node_modules/@agentproto/cli/dist/cli.mjs",
        "linux",
      ),
    ).toBeUndefined()
  })

  it("returns undefined for another package under the same root", () => {
    expect(
      npmGlobalPrefixFromEntry(
        "/home/dev/.local/lib/node_modules/other-cli/dist/cli.mjs",
        "linux",
      ),
    ).toBeUndefined()
  })
})

describe("withNpmGlobalPrefix", () => {
  const prefix = "/home/dev/.local"

  it("pins a global install to the CLI prefix", () => {
    expect(
      withNpmGlobalPrefix(["install", "-g", "@agentproto/adapter-x"], prefix),
    ).toEqual([
      "install",
      "--prefix",
      "/home/dev/.local",
      "-g",
      "@agentproto/adapter-x",
    ])
  })

  it("pins a global uninstall too", () => {
    expect(
      withNpmGlobalPrefix(["uninstall", "-g", "@agentproto/adapter-x"], prefix),
    ).toContain("--prefix")
  })

  it("leaves local installs untouched", () => {
    expect(
      withNpmGlobalPrefix(["install", "@agentproto/adapter-x"], prefix),
    ).toEqual(["install", "@agentproto/adapter-x"])
  })

  it("does not stack a second --prefix", () => {
    const args = ["install", "-g", "--prefix", "/other", "pkg"]
    expect(withNpmGlobalPrefix(args, prefix)).toEqual(args)
  })

  it("is a no-op when no prefix was detected", () => {
    const args = ["install", "-g", "pkg"]
    expect(withNpmGlobalPrefix(args, undefined)).toEqual(args)
  })
})
