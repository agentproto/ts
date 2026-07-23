/**
 * `agentproto daemon` lifecycle hardening: the crash-only KeepAlive in the
 * generated plist, plus the idempotent `start` (kickstart, no -k) vs the
 * force-cycle `restart` (kickstart -k). `runStart`/`runRestart` take an
 * injectable launchctl runner so we assert the exact argv without spawning a
 * real `launchctl`; `renderPlist` is pure so we assert its output directly.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { renderPlist, runStart, runRestart } from "../commands/daemon.js"

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
    const code = await runStart(fakeLaunchctl)
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
    const code = await runRestart(fakeLaunchctl)
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
    const code = await runStart(fakeLaunchctl)
    errSpy.mockRestore()
    expect(code).toBe(5)
  })
})
