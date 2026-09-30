/**
 * Win32 batch-file spawn resolution (`win32-spawn.ts`) — recap point 10:
 * the device-sandbox host spawn on Windows died with Node `spawn EINVAL`
 * because `resolveSpawnBin` hands the ACP/print arms an ABSOLUTE
 * `npx.cmd` shim and Node ≥ 18.20.2 (CVE-2024-27980) refuses to spawn
 * `.cmd`/`.bat` without `shell: true`. Platform-mocked, no real spawn.
 */

import { describe, expect, it } from "vitest"
import { join } from "node:path"
import {
  isWindowsBatchFile,
  resolveWindowsBatchSpawn,
  windowsBatchShellOption,
} from "../win32-spawn.js"

const WIN = { platform: "win32" as NodeJS.Platform }
const NODEJS_DIR = "C:\\Program Files\\nodejs"
// path.join keeps adding platform separators for every segment — the
// rewritten script path under the shim's dir (same composition the module
// does); asserting with join keeps the test faithful without hard-coding
// separator quirks of the host building the fixture.
const NPM_BIN_JS = join(NODEJS_DIR, "node_modules", "npm", "bin", "npx-cli.js")
const NPM_CLI_JS = join(NODEJS_DIR, "node_modules", "npm", "bin", "npm-cli.js")
const execPath = "C:\\Program Files\\nodejs\\node.exe"

describe("isWindowsBatchFile", () => {
  it("matches .cmd/.bat case-insensitively on win32 only", () => {
    expect(isWindowsBatchFile("C:\\tools\\npx.cmd", WIN)).toBe(true)
    expect(isWindowsBatchFile("C:\\tools\\thing.BAT", WIN)).toBe(true)
    expect(isWindowsBatchFile("C:\\tools\\npx", WIN)).toBe(false)
    expect(isWindowsBatchFile("C:\\tools\\node.exe", WIN)).toBe(false)
    expect(isWindowsBatchFile("npx.cmd", { platform: "darwin" })).toBe(false)
    expect(isWindowsBatchFile("npx.cmd", { platform: "linux" })).toBe(false)
  })
})

describe("resolveWindowsBatchSpawn", () => {
  it("off on POSIX — the shim problem does not exist there", () => {
    expect(resolveWindowsBatchSpawn("npx.cmd", ["-y"], { platform: "darwin" })).toBeUndefined()
  })

  it("rewrites the npx.cmd shim to node <npm>/bin/npx-cli.js (behavior of the shim itself)", () => {
    const res = resolveWindowsBatchSpawn(
      join(NODEJS_DIR, "npx.cmd"),
      ["-y", "opencode-ai", "acp"],
      { ...WIN, execPath, exists: (p) => p === NPM_BIN_JS },
    )
    expect(res).toBeDefined()
    expect(res!.bin).toBe(execPath)
    expect(res!.args[0]).toBe(NPM_BIN_JS)
    expect(res!.args.slice(1)).toEqual(["-y", "opencode-ai", "acp"])
  })

  it("rewrites npm.cmd the same way (npm-cli.js)", () => {
    const res = resolveWindowsBatchSpawn(join(NODEJS_DIR, "npm.cmd"), ["i", "-g", "pkg"], {
      ...WIN,
      execPath,
      exists: (p) => p === NPM_CLI_JS,
    })
    expect(res!.args[0]).toBe(NPM_CLI_JS)
    expect(res!.args.slice(1)).toEqual(["i", "-g", "pkg"])
  })

  it("leaves a shim whose companion JS is missing (the npm global-bin layout without the script) — caller falls back to shell:true", () => {
    const res = resolveWindowsBatchSpawn("C:\\npm\\npx.cmd", ["-y", "pkg"], {
      ...WIN,
      exists: () => false,
    })
    expect(res).toBeUndefined()
  })

  it("never rewrites a third-party .cmd shim (no npm family JS exists for it)", () => {
    expect(
      resolveWindowsBatchSpawn("C:\\npm\\opencode.cmd", ["acp"], {
        ...WIN,
        exists: () => true,
      })
    ).toBeUndefined()
  })
})

describe("windowsBatchShellOption", () => {
  it("shell:true only for a batch file on win32 — the last-resort spawn option", () => {
    expect(windowsBatchShellOption("C:\\npm\\opencode.cmd", WIN)).toEqual({ shell: true })
    expect(windowsBatchShellOption("C:\\npm\\opencode", WIN)).toEqual({})
    expect(windowsBatchShellOption("npx.cmd", { platform: "darwin" })).toEqual({})
  })
})
