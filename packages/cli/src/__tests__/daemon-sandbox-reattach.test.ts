/**
 * `agentproto daemon restart` reports sandbox sessions as DETACHED (box keeps
 * running) before the kickstart and how many were re-attached after boot.
 * Same injectable-launchctl / injectable-health seams as daemon-lifecycle.test.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  awaitSandboxReattach,
  runRestart,
  type DaemonHealthInfo,
  type PathSyncFn,
} from "../commands/daemon.js"

const noSyncPath: PathSyncFn = async () => false
const okLaunchctl = async () => ({ code: 0, stdout: "", stderr: "" })

const base: DaemonHealthInfo = {
  url: "http://127.0.0.1:18790",
  version: "1.0.0",
  pid: 1,
  node: "/usr/bin/node",
  entry: "/x/cli.mjs",
  workspace: "/w",
  uptimeMs: 100,
}

const withSandbox = (
  attached: number,
  reattach: Partial<NonNullable<DaemonHealthInfo["sandboxSessions"]>["reattach"]> = {},
): DaemonHealthInfo => ({
  ...base,
  sandboxSessions: {
    attached,
    reattach: { detachedAtBoot: 0, reattached: 0, gone: 0, failed: 0, pending: 0, ...reattach },
  },
})

function captureStdout(): { text: () => string; restore: () => void } {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((c: string | Uint8Array) => {
    chunks.push(String(c))
    return true
  }) as typeof process.stdout.write)
  return { text: () => chunks.join(""), restore: () => spy.mockRestore() }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("daemon restart — sandbox sessions", () => {
  it("announces the detach before the kickstart and the re-attach tally after boot", async () => {
    const order: string[] = []
    const launchctl = vi.fn(async () => {
      order.push("kickstart")
      return { code: 0, stdout: "", stderr: "" }
    })
    let calls = 0
    const health = vi.fn(async () => {
      calls++
      if (calls === 1) {
        order.push("pre-health")
        return withSandbox(2)
      }
      // Post-boot: first answer still has the pass running, the next has it settled.
      return calls === 2
        ? withSandbox(0, { detachedAtBoot: 2, pending: 2 })
        : withSandbox(2, { detachedAtBoot: 2, reattached: 1, gone: 1, pending: 0 })
    })
    const out = captureStdout()
    const code = await runRestart(launchctl, health, 5, noSyncPath, 1)
    out.restore()

    expect(code).toBe(0)
    expect(order.slice(0, 2)).toEqual(["pre-health", "kickstart"])
    const text = out.text()
    expect(text).toContain("2 sandbox sessions will be detached")
    expect(text).toContain("not killed")
    expect(text).toContain("re-attached 1/2 sandbox sessions (1 gone)")
  })

  it("prints nothing about sandboxes when none were attached", async () => {
    const out = captureStdout()
    await runRestart(okLaunchctl, async () => withSandbox(0), 3, noSyncPath, 1)
    out.restore()
    expect(out.text()).not.toContain("sandbox")
  })

  it("a daemon that predates sandbox detach (no field) restarts as before", async () => {
    const out = captureStdout()
    const code = await runRestart(okLaunchctl, async () => base, 3, noSyncPath, 1)
    out.restore()
    expect(code).toBe(0)
    expect(out.text()).not.toContain("sandbox")
  })
})

describe("awaitSandboxReattach", () => {
  it("returns an empty string when nothing was detached", async () => {
    expect(await awaitSandboxReattach(async () => base, 0, base, 2, 1)).toBe("")
  })

  it("polls until the pass settles and singularises one session", async () => {
    const health = vi
      .fn<() => Promise<DaemonHealthInfo | null>>()
      .mockResolvedValueOnce(withSandbox(0, { detachedAtBoot: 1, pending: 1 }))
      .mockResolvedValue(withSandbox(1, { detachedAtBoot: 1, reattached: 1, pending: 0 }))
    const line = await awaitSandboxReattach(health, 1, withSandbox(0, { detachedAtBoot: 1, pending: 1 }), 10, 1)
    expect(line).toBe("  sandbox:   re-attached 1/1 sandbox session\n")
  })

  it("reports unreachable and still-pending boxes when the pass does not settle", async () => {
    const stuck = withSandbox(0, { detachedAtBoot: 3, reattached: 1, failed: 1, pending: 1 })
    const line = await awaitSandboxReattach(async () => stuck, 3, stuck, 2, 1)
    expect(line).toContain("re-attached 1/3 sandbox sessions (1 unreachable, 1 still pending)")
  })

  it("says the status is unavailable when the new daemon never reports it", async () => {
    const line = await awaitSandboxReattach(async () => null, 2, null, 2, 1)
    expect(line).toContain("2 detached; re-attach status unavailable")
  })
})
