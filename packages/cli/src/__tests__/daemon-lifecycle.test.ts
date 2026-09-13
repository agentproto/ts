/**
 * `agentproto daemon` lifecycle hardening: the crash-only KeepAlive in the
 * generated plist, plus the idempotent `start` (kickstart, no -k) vs the
 * force-cycle `restart` (kickstart -k). `runStart`/`runRestart` take an
 * injectable launchctl runner so we assert the exact argv without spawning a
 * real `launchctl`; `renderPlist` is pure so we assert its output directly.
 *
 * Every `runStart`/`runRestart` call below passes an explicit `noSyncPath`
 * stub for the 4th (PATH self-heal) argument. The real default
 * (`selfHealDaemonPath`) reads/writes the ACTUAL
 * `~/Library/LaunchAgents/sh.agentproto.plist` on whatever machine runs this
 * suite — on a dev box that has ever run `agentproto daemon install`, that
 * file exists for real, so leaving it unstubbed would let a test run rewrite
 * a real launchd job definition. Never rely on the default here.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import {
  renderPlist,
  runStart,
  runRestart,
  runStop,
  type DaemonHealthInfo,
  type DaemonStopStats,
  type PathSyncFn,
} from "../commands/daemon.js"

const HEALTH: DaemonHealthInfo = {
  url: "http://127.0.0.1:18790",
  version: "0.31.0",
  pid: 12345,
  node: "/usr/local/bin/node",
  entry: "/opt/agentproto/cli.mjs",
  workspace: "/work/space",
  uptimeMs: 2_000,
}

const fakeHealth = async (): Promise<DaemonHealthInfo | null> => HEALTH
const noHealth = async (): Promise<DaemonHealthInfo | null> => null

/** Never touches real files/launchctl — see the file-level note above. */
const noSyncPath: PathSyncFn = async () => false

function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = []
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk))
      return true
    })
  return { chunks, restore: () => spy.mockRestore() }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("renderPlist KeepAlive", () => {
  const plist = renderPlist({
    label: "sh.agentproto",
    fullArgv: ["/usr/bin/node", "/path/cli.mjs", "serve"],
    logPath: "/home/u/.agentproto/daemon.log",
    path: "/usr/local/bin:/usr/bin:/bin",
  })

  it("emits a crash-only KeepAlive dict (SuccessfulExit false)", () => {
    expect(plist).toContain("<key>KeepAlive</key>")
    expect(plist).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key><false\/>\s*<\/dict>/,
    )
  })

  it("no longer emits the always-restart `KeepAlive: true` form", () => {
    expect(plist).not.toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
  })
})

describe("agentproto daemon start (idempotent) vs restart (force-cycle)", () => {
  it("start uses `kickstart` WITHOUT -k and reports started", async () => {
    const calls: string[][] = []
    const fakeLaunchctl = vi.fn(async (args: string[]) => {
      calls.push(args)
      return { code: 0, stdout: "", stderr: "" }
    })
    const out = captureStdout()
    const code = await runStart(fakeLaunchctl, fakeHealth, 20, noSyncPath)
    out.restore()

    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(["kickstart", expect.stringContaining("sh.agentproto")])
    expect(calls[0]).not.toContain("-k")
    expect(out.chunks.join("")).toContain("started")
  })

  it("restart uses `kickstart -k` and reports restarted", async () => {
    const calls: string[][] = []
    const fakeLaunchctl = vi.fn(async (args: string[]) => {
      calls.push(args)
      return { code: 0, stdout: "", stderr: "" }
    })
    const out = captureStdout()
    const code = await runRestart(fakeLaunchctl, fakeHealth, 20, noSyncPath)
    out.restore()

    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
    const args = calls[0] ?? []
    expect(args[0]).toBe("kickstart")
    expect(args[1]).toBe("-k")
    expect(args[2]).toContain("sh.agentproto")
    expect(out.chunks.join("")).toContain("restarted")
  })

  it("start surfaces a non-zero launchctl exit with an install hint", async () => {
    const fakeLaunchctl = vi.fn(async () => ({
      code: 5,
      stdout: "",
      stderr: "No such service",
    }))
    const errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true)
    const code = await runStart(fakeLaunchctl, noHealth, 1, noSyncPath)
    errSpy.mockRestore()
    expect(code).toBe(5)
  })
})

describe("agentproto daemon start/restart — lifecycle info block", () => {
  const okLaunchctl = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }))

  it("prints version, pid, bin, url, workspace and log path from /health", async () => {
    const out = captureStdout()
    await runStart(okLaunchctl, fakeHealth, 20, noSyncPath)
    out.restore()
    const text = out.chunks.join("")
    expect(text).toContain("version:   0.31.0 · pid 12345 · up 2s")
    expect(text).toContain("bin:       /usr/local/bin/node /opt/agentproto/cli.mjs")
    expect(text).toContain("url:       http://127.0.0.1:18790")
    expect(text).toContain("workspace: /work/space")
    expect(text).toContain("logs:")
  })

  it("degrades to a hint when the daemon never answers /health", async () => {
    const out = captureStdout()
    await runRestart(okLaunchctl, noHealth, 1, noSyncPath)
    out.restore()
    expect(out.chunks.join("")).toContain("not answering /health yet")
  })
})

describe("agentproto daemon stop — lifetime summary", () => {
  it("gathers stats BEFORE the SIGTERM and prints uptime, sessions and tokens", async () => {
    const order: string[] = []
    const fakeLaunchctl = vi.fn(async (args: string[]) => {
      order.push("kill")
      expect(args).toEqual(["kill", "SIGTERM", expect.stringContaining("sh.agentproto")])
      return { code: 0, stdout: "", stderr: "" }
    })
    const gather = vi.fn(async (): Promise<DaemonStopStats> => {
      order.push("gather")
      return {
        uptimeMs: 11_520_000,
        version: "0.31.0",
        sessions: 17,
        tokensIn: 1_234_567,
        tokensOut: 340_000,
        unpricedTokens: 12_000,
        spentUsd: 4.31,
      }
    })
    const out = captureStdout()
    const code = await runStop(fakeLaunchctl, gather)
    out.restore()

    expect(code).toBe(0)
    expect(order).toEqual(["gather", "kill"])
    const text = out.chunks.join("")
    expect(text).toContain("SIGTERM sent")
    expect(text).toContain("ran:       3h12m · v0.31.0")
    expect(text).toContain("activity:  17 sessions · 1.2M in / 340k out tok · ~$4.31 est · 12k unpriced")
  })

  it("keeps the plain SIGTERM line when the daemon was already unreachable", async () => {
    const fakeLaunchctl = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }))
    const out = captureStdout()
    const code = await runStop(fakeLaunchctl, async () => null)
    out.restore()
    expect(code).toBe(0)
    const text = out.chunks.join("")
    expect(text).toContain("SIGTERM sent")
    expect(text).not.toContain("ran:")
  })
})
