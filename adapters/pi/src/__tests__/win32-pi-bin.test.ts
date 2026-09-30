/**
 * `resolveWindowsPiSpawn` / `locateWindowsPi` — issue #1637 defect 2: a
 * Windows pi install only ever puts a `.cmd` shim on PATH (`pi.cmd` under
 * `%USERPROFILE%\.pi\agent\bin` for the curl installer, or the npm global
 * prefix `bin/`), and Node's `spawn` without `shell` does not PATHEXT-
 * resolve `pi` → `pi.cmd`, so every pi session start died `spawn pi ENOENT`.
 * Platform-mocked, deps-injection test style of the driver's
 * `win32-batch-spawn.test.ts` — no real filesystem, no real spawn.
 */

import { describe, expect, it } from "vitest"
import { join } from "node:path"
import { resolveWindowsPiSpawn } from "../win32-pi-bin.js"

const WIN = { platform: "win32" as NodeJS.Platform }
// PATH fixtures are `;`-joined mock segment NAMES, built through the same
// `join` the module probes with — a darwin host keeps POSIX separators
// inside these "win32-shaped" segments, so hard-coding `C:\…` backslashes
// in the matchers would race the module's own composition. Entries never
// contain the drive-letter colon to stay faithful to both hosts.
const NPM_BIN_DIR = "npm-global-bin"
const CUR_BIN_DIR = "user-pi-agent-bin"
const NODE = "C:\\Program Files\\nodejs\\node.exe"
const ARGS = ["--mode", "rpc"] as const

// fixture builder — the fixture path the module probe must find
const shimPath = (dir: string) => join(dir, "pi.cmd")
const exePath = (dir: string) => join(dir, "pi.exe")
const nativePath = (dir: string) => join(dir, "pi")
// the package entry JS the pi.cmd npm shim wraps
const entryJs = (dir: string) =>
  join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js")

describe("locate/resolve on win32", () => {
  it("POSIX is a pure passthrough — undefined, caller spawns the bare spec", () => {
    expect(
      resolveWindowsPiSpawn("pi", ARGS, { ...WIN, platform: "darwin" as NodeJS.Platform }),
    ).toBeUndefined()
    expect(
      resolveWindowsPiSpawn("pi", ARGS, { ...WIN, platform: "linux" as NodeJS.Platform }),
    ).toBeUndefined()
  })

  it("pi.cmd with a sibling package entry JS → node <entry> rewrite, shell:false", () => {
    const entry = entryJs(NPM_BIN_DIR)
    const other = shimPath("unrelated-dir")
    const res = resolveWindowsPiSpawn("pi", ARGS, {
      ...WIN,
      execPath: NODE,
      pathEnv: ["unrelated-dir", NPM_BIN_DIR].join(";"),
      exists: (p) => p === shimPath(NPM_BIN_DIR) || p === entry,
    })
    expect(res).toBeDefined()
    expect(res!.bin).toBe(NODE)
    expect(res!.args[0]).toBe(entry)
    expect(res!.args.slice(1)).toEqual([...ARGS])
    expect(res!.shell).toBeUndefined()
  })

  it("pi.cmd WITHOUT a sibling package entry JS (curl-install layout) → spawn the shim with shell:true", () => {
    const res = resolveWindowsPiSpawn("pi", ARGS, {
      ...WIN,
      pathEnv: CUR_BIN_DIR,
      exists: (p) => p === shimPath(CUR_BIN_DIR),
    })
    expect(res).toBeDefined()
    expect(res!.bin).toBe(shimPath(CUR_BIN_DIR))
    expect(res!.args).toEqual([...ARGS])
    expect(res!.shell).toBe(true)
  })

  it("pi.exe present → direct spawn, no shell option", () => {
    const res = resolveWindowsPiSpawn("pi", ARGS, {
      ...WIN,
      pathEnv: "tools-dir",
      exists: (p) => p === exePath("tools-dir"),
    })
    expect(res).toBeDefined()
    expect(res!.bin).toBe(exePath("tools-dir"))
    expect(res!.args).toEqual([...ARGS])
    expect(res!.shell).toBeUndefined()
  })

  it("first PATH entry wins — a native pi earlier on PATH beats a shim later", () => {
    const entry = entryJs(NPM_BIN_DIR)
    const res = resolveWindowsPiSpawn("pi", ARGS, {
      ...WIN,
      execPath: NODE,
      pathEnv: ["native-dir", NPM_BIN_DIR].join(";"),
      exists: (p) => p === nativePath("native-dir") || p === shimPath(NPM_BIN_DIR) || p === entry,
    })
    expect(res!.bin).toBe(nativePath("native-dir"))
  })

  it("an explicit AGENTPROTO_PI_BIN override ending in .cmd also gets the rewrite/shell treatment", () => {
    const overrideDir = join("/", "custom", "bin")
    const shim = shimPath(overrideDir)
    const entry = entryJs(overrideDir)
    const rewritten = resolveWindowsPiSpawn(shim, ARGS, {
      ...WIN,
      execPath: NODE,
      pathEnv: "",
      exists: (p) => p === shim || p === entry,
    })
    expect(rewritten!.args[0]).toBe(entry)
    const shell = resolveWindowsPiSpawn(shim, ARGS, {
      ...WIN,
      pathEnv: "",
      exists: (p) => p === shim,
    })
    expect(shell!.shell).toBe(true)
  })

  it("no PATH hit and no explicit override → undefined (caller surfaces spawn ENOENT)", () => {
    expect(
      resolveWindowsPiSpawn("pi", ARGS, { ...WIN, pathEnv: "empty", exists: () => false }),
    ).toBeUndefined()
  })

  it("shell:true fallback quotes a shim path containing a space", () => {
    const spacedDir = join("C:\\Program Files", "pi-agent-bin")
    const shim = shimPath(spacedDir)
    const res = resolveWindowsPiSpawn("pi", ARGS, {
      ...WIN,
      pathEnv: spacedDir,
      exists: (p) => p === shim,
    })
    expect(res).toBeDefined()
    expect(res!.shell).toBe(true)
    expect(res!.bin).toBe(`"${shim}"`)
    // args here don't contain spaces, so they pass through unquoted
    expect(res!.args).toEqual([...ARGS])
  })

  it("shell:true fallback quotes an arg containing a space too", () => {
    const dir = CUR_BIN_DIR
    const shim = shimPath(dir)
    const argsWithSpace = ["--session", "a session id"] as const
    const res = resolveWindowsPiSpawn("pi", argsWithSpace, {
      ...WIN,
      pathEnv: dir,
      exists: (p) => p === shim,
    })
    expect(res!.args).toEqual(["--session", `"a session id"`])
  })

  it("an explicit absolute AGENTPROTO_PI_BIN override takes precedence over an unrelated pi hit on PATH", () => {
    const overrideDir = join("/", "custom", "bin")
    const shim = shimPath(overrideDir)
    const otherDir = "other-pi-on-path"
    const otherShim = shimPath(otherDir)
    const res = resolveWindowsPiSpawn(shim, ARGS, {
      ...WIN,
      pathEnv: otherDir,
      // Both the override AND an unrelated PATH entry resolve — the
      // override must win, not the PATH scan.
      exists: (p) => p === shim || p === otherShim,
    })
    expect(res).toBeDefined()
    expect(res!.bin).toBe(shim)
    expect(res!.shell).toBe(true)
  })
})
