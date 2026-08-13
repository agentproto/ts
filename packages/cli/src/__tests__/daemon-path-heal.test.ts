/**
 * `agentproto daemon start|restart` PATH self-heal: `install` bakes the
 * plist's `EnvironmentVariables.PATH` once, from the installing invocation's
 * `process.env.PATH`. A CLI installed afterwards (e.g. `uv tool install
 * mistral-vibe`, landing in `~/.local/bin` via a line only sourced for
 * interactive shells) was invisible to the daemon forever — even across
 * `daemon restart` — because `kickstart` alone never re-renders the plist.
 *
 * These tests cover the pure/testable core of the fix:
 *   - `computeDaemonPath`  — dedup + append well-known extra bin dirs
 *   - `pathNeedsRefresh`   — the "only rewrite if changed" gate
 *   - `refreshPlistPathIfNeeded` — gating + rewrite + re-bootstrap, with
 *     the plist XML, freshly-computed PATH, `writeFile`, and `launchctl`
 *     runner all passed in explicitly, so nothing here ever touches a real
 *     file or spawns a real process.
 *
 * `probeLoginShellPath`/`selfHealDaemonPath` (the real IO wiring) are
 * exercised only implicitly, through `runStart`/`runRestart`'s injectable
 * `syncPath` parameter in daemon-lifecycle.test.ts — never with their
 * defaults, since a dev box that ever ran `agentproto daemon install` has a
 * REAL `~/Library/LaunchAgents/sh.agentproto.plist` this suite must not
 * touch.
 */

import { describe, it, expect } from "vitest"
import { homedir } from "node:os"
import {
  computeDaemonPath,
  pathNeedsRefresh,
  refreshPlistPathIfNeeded,
  renderPlist,
  EXTRA_PATH_DIRS,
} from "../commands/daemon.js"

describe("computeDaemonPath", () => {
  it("dedups a `:`-joined PATH, preserving first-seen order", () => {
    const out = computeDaemonPath("/usr/bin:/bin:/usr/bin:/bin:/opt/x", [])
    expect(out).toBe("/usr/bin:/bin:/opt/x")
  })

  it("drops empty segments (leading/trailing/double colons)", () => {
    const out = computeDaemonPath(":/usr/bin::/bin:", [])
    expect(out).toBe("/usr/bin:/bin")
  })

  it("appends extra dirs not already present, existing entries win (no dupes)", () => {
    const out = computeDaemonPath("/usr/bin:/opt/homebrew/bin", [
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ])
    expect(out).toBe("/usr/bin:/opt/homebrew/bin:/usr/local/bin")
  })

  it("expands a leading `~` in extra dirs against homedir()", () => {
    const out = computeDaemonPath("/usr/bin", ["~/.local/bin", "~/.cargo/bin"])
    expect(out).toBe(`/usr/bin:${homedir()}/.local/bin:${homedir()}/.cargo/bin`)
  })

  it("defaults to EXTRA_PATH_DIRS (~/.local/bin, /opt/homebrew/bin, /usr/local/bin, ~/.cargo/bin)", () => {
    const out = computeDaemonPath("/usr/bin")
    expect(out).toBe(
      [
        "/usr/bin",
        `${homedir()}/.local/bin`,
        "/opt/homebrew/bin",
        "/usr/local/bin",
        `${homedir()}/.cargo/bin`,
      ].join(":"),
    )
    // Sanity: the exported default list itself hasn't drifted from the doc.
    expect(EXTRA_PATH_DIRS).toEqual([
      "~/.local/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "~/.cargo/bin",
    ])
  })

  it("is idempotent — running it twice on its own output changes nothing", () => {
    const once = computeDaemonPath("/usr/bin:/bin")
    const twice = computeDaemonPath(once)
    expect(twice).toBe(once)
  })
})

describe("pathNeedsRefresh", () => {
  it("is false when there's no current plist PATH to refresh (nothing installed)", () => {
    expect(pathNeedsRefresh(null, "/usr/bin:/bin")).toBe(false)
  })

  it("is false when current already equals fresh", () => {
    expect(pathNeedsRefresh("/usr/bin:/bin", "/usr/bin:/bin")).toBe(false)
  })

  it("is true when current differs from fresh", () => {
    expect(pathNeedsRefresh("/usr/bin", "/usr/bin:/Users/u/.local/bin")).toBe(true)
  })
})

describe("refreshPlistPathIfNeeded — only rewrite/re-bootstrap when PATH actually changed", () => {
  const fullArgv = ["/usr/bin/node", "/path/cli.mjs", "serve"]
  const logPath = "/home/u/.agentproto/daemon.log"

  function xmlWithPath(path: string): string {
    return renderPlist({ label: "sh.agentproto", fullArgv, logPath, path })
  }

  it("no-ops when there's no currently-installed plist (currentXml null)", async () => {
    const run = async () => ({ code: 0, stdout: "", stderr: "" })
    let writeCalls = 0
    const changed = await refreshPlistPathIfNeeded({
      plistPath: "/home/u/Library/LaunchAgents/sh.agentproto.plist",
      currentXml: null,
      fullArgv,
      logPath,
      freshPath: "/usr/bin:/bin",
      run,
      writeFile: async () => {
        writeCalls++
      },
    })
    expect(changed).toBe(false)
    expect(writeCalls).toBe(0)
  })

  it("no-ops (no write, no bootout/bootstrap) when the PATH is unchanged", async () => {
    const runCalls: string[][] = []
    const run = async (args: string[]) => {
      runCalls.push(args)
      return { code: 0, stdout: "", stderr: "" }
    }
    let writeCalls = 0
    const freshPath = "/usr/bin:/bin"
    const changed = await refreshPlistPathIfNeeded({
      plistPath: "/home/u/Library/LaunchAgents/sh.agentproto.plist",
      currentXml: xmlWithPath(freshPath),
      fullArgv,
      logPath,
      freshPath,
      run,
      writeFile: async () => {
        writeCalls++
      },
    })
    expect(changed).toBe(false)
    expect(writeCalls).toBe(0)
    expect(runCalls).toHaveLength(0)
  })

  it("rewrites the plist and bootout-then-bootstraps when the PATH changed", async () => {
    const runCalls: string[][] = []
    const run = async (args: string[]) => {
      runCalls.push(args)
      return { code: 0, stdout: "", stderr: "" }
    }
    const writes: Array<{ path: string; data: string }> = []
    const freshPath = "/usr/bin:/bin:/Users/u/.local/bin"
    const plistPath = "/home/u/Library/LaunchAgents/sh.agentproto.plist"
    const changed = await refreshPlistPathIfNeeded({
      plistPath,
      currentXml: xmlWithPath("/usr/bin:/bin"),
      fullArgv,
      logPath,
      freshPath,
      run,
      writeFile: async (path, data) => {
        writes.push({ path, data })
      },
    })

    expect(changed).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writes[0]?.path).toBe(plistPath)
    expect(writes[0]?.data).toContain(
      "<key>PATH</key><string>/usr/bin:/bin:/Users/u/.local/bin</string>",
    )
    // bootout BEFORE bootstrap, in that order — matches runInstall's sequence.
    expect(runCalls).toHaveLength(2)
    expect(runCalls[0]?.[0]).toBe("bootout")
    expect(runCalls[0]?.[1]).toContain("sh.agentproto")
    expect(runCalls[1]?.[0]).toBe("bootstrap")
    expect(runCalls[1]?.[2]).toBe(plistPath)
  })

  it("preserves the rest of the plist (argv, log path, KeepAlive) across a PATH-only rewrite", async () => {
    const run = async () => ({ code: 0, stdout: "", stderr: "" })
    const writes: Array<{ path: string; data: string }> = []
    await refreshPlistPathIfNeeded({
      plistPath: "/home/u/Library/LaunchAgents/sh.agentproto.plist",
      currentXml: xmlWithPath("/usr/bin"),
      fullArgv,
      logPath,
      freshPath: "/usr/bin:/opt/homebrew/bin",
      run,
      writeFile: async (path, data) => {
        writes.push({ path, data })
      },
    })
    const rewritten = writes[0]?.data ?? ""
    expect(rewritten).toContain("<string>/usr/bin/node</string>")
    expect(rewritten).toContain("<string>/path/cli.mjs</string>")
    expect(rewritten).toContain("<string>serve</string>")
    expect(rewritten).toContain(`<string>${logPath}</string>`)
    expect(rewritten).toContain("<key>SuccessfulExit</key><false/>")
  })
})
