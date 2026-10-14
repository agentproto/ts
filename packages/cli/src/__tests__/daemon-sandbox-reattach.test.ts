/**
 * `agentproto daemon restart` reports sandbox sessions as DETACHED (box keeps
 * running) before the kickstart and how many were re-attached after boot.
 * Same injectable-launchctl / injectable-health seams as daemon-lifecycle.test.ts.
 *
 * The wait is WALL-CLOCK BOUNDED (`REATTACH_WAIT_DEFAULT_MS`): a progress line
 * goes out immediately, and a pass that hasn't settled by the cap is left
 * running in the daemon with a pointer to `agentproto daemon status` — no more
 * ~2.5 minutes of silence followed by a bare "still pending".
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  awaitSandboxReattach,
  renderSandboxTally,
  REATTACH_WAIT_DEFAULT_MS,
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
    expect(text).toContain("re-attaching 2 sandbox sessions")
    expect(text).toContain("re-attached 1/2 sandbox sessions (1 gone)")
    expect(text).not.toContain("pass continues in the daemon")
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

  it("surfaces unserved rows as a note and does not wait on them", async () => {
    let calls = 0
    const health = vi.fn(async () => {
      calls++
      // Pre-restart: nothing attached. Post-boot: all detached rows belong to
      // another workspace, so this daemon's pass has nothing to resolve.
      return calls === 1
        ? withSandbox(0)
        : withSandbox(0, { detachedAtBoot: 3, unserved: 3, pending: 0 })
    })
    const out = captureStdout()
    const code = await runRestart(okLaunchctl, health, 3, noSyncPath, 1)
    out.restore()

    expect(code).toBe(0)
    const text = out.text()
    expect(text).toContain("3 detached rows belong to other workspaces (not served by this daemon)")
    expect(text).not.toContain("still pending")
    expect(text).not.toContain("pass continues in the daemon")
  })
})

describe("awaitSandboxReattach", () => {
  it("returns an empty string when nothing was detached", async () => {
    expect(await awaitSandboxReattach(async () => base, 0, base, 10, 1)).toBe("")
  })

  it("polls until the pass settles and singularises one session", async () => {
    const health = vi
      .fn<() => Promise<DaemonHealthInfo | null>>()
      .mockResolvedValueOnce(withSandbox(0, { detachedAtBoot: 1, pending: 1 }))
      .mockResolvedValue(withSandbox(1, { detachedAtBoot: 1, reattached: 1, pending: 0 }))
    const line = await awaitSandboxReattach(
      health,
      1,
      withSandbox(0, { detachedAtBoot: 1, pending: 1 }),
      1_000,
      1,
    )
    expect(line).toBe("  sandbox:   re-attached 1/1 sandbox session\n")
  })

  it("reports unreachable and still-pending boxes when the pass does not settle", async () => {
    const stuck = withSandbox(0, { detachedAtBoot: 3, reattached: 1, failed: 1, pending: 1 })
    const line = await awaitSandboxReattach(async () => stuck, 3, stuck, 5, 1)
    expect(line).toContain("re-attached 1/3 sandbox sessions (1 unreachable, 1 still pending)")
  })

  it("says the status is unavailable when the new daemon never reports it", async () => {
    const line = await awaitSandboxReattach(async () => null, 2, null, 5, 1)
    expect(line).toContain("2 detached; re-attach status unavailable")
  })

  it("notes unserved rows as belonging to other workspaces and never reports them as pending", async () => {
    const info = withSandbox(0, { detachedAtBoot: 3, unserved: 3, pending: 0 })
    const line = await awaitSandboxReattach(async () => info, 3, info, 5, 1)
    expect(line).toContain("3 detached rows belong to other workspaces (not served by this daemon)")
    expect(line).not.toContain("still pending")
    expect(line).not.toContain("re-attached")
  })

  it("excludes unserved rows from the tally denominator while still reporting the rest", async () => {
    const info = withSandbox(1, { detachedAtBoot: 3, unserved: 1, reattached: 2, pending: 0 })
    const line = await awaitSandboxReattach(async () => info, 3, info, 5, 1)
    expect(line).toContain("re-attached 2/2 sandbox sessions")
    expect(line).toContain("1 detached row belong to other workspaces (not served by this daemon)")
  })

  it("prints a progress line up front instead of sitting silent", async () => {
    const stuck = withSandbox(0, { detachedAtBoot: 3, pending: 3 })
    const out = captureStdout()
    const line = await awaitSandboxReattach(async () => stuck, 3, stuck, 5, 1)
    out.restore()
    expect(out.text()).toContain("re-attaching 3 sandbox sessions")
    expect(line).toContain("3 still pending")
  })

  it("caps the wait at the deadline budget and points at `daemon status` when it gives up", async () => {
    const stuck = withSandbox(0, { detachedAtBoot: 3, pending: 3 })
    let polls = 0
    const health = vi.fn(async () => {
      polls++
      return stuck
    })
    const out = captureStdout()
    const startedAt = Date.now()
    const line = await awaitSandboxReattach(health, 3, stuck, 120, 10)
    const elapsed = Date.now() - startedAt
    out.restore()

    // Bounded by maxWaitMs (+ one poll/fetch), not by "attempts": well under
    // the old 120 × (500ms + 800ms fetch) ~2.5-minute budget.
    expect(elapsed).toBeLessThan(2_000)
    expect(polls).toBeLessThanOrEqual(20)
    expect(line).toContain("3 still pending")
    expect(line).toContain("re-attach pass continues in the daemon")
    expect(line).toContain("agentproto daemon status")
  })

  it("skips the progress line when the pass already settled before we look", async () => {
    const settled = withSandbox(2, { detachedAtBoot: 3, reattached: 3, pending: 0 })
    const out = captureStdout()
    const line = await awaitSandboxReattach(async () => settled, 3, settled, 50, 5)
    out.restore()
    expect(out.text()).not.toContain("re-attaching")
    expect(line).toContain("re-attached 3/3 sandbox sessions")
  })

  it("exports a wait budget on the runtime's per-row deadline plus margin", () => {
    expect(REATTACH_WAIT_DEFAULT_MS).toBeGreaterThanOrEqual(45_000)
    expect(REATTACH_WAIT_DEFAULT_MS).toBeLessThanOrEqual(120_000)
  })
})

describe("renderSandboxTally (daemon status)", () => {
  it("shows the attached count plus the reattach tally while rows are pending", () => {
    const line = renderSandboxTally({
      attached: 2,
      reattach: { detachedAtBoot: 3, reattached: 1, gone: 1, failed: 0, pending: 1 },
    })
    expect(line).toContain("2 attached")
    expect(line).toContain("re-attached 1/3 sandbox sessions (1 gone, 1 still pending)")
  })

  it("notes unserved rows and keeps them out of the tally and out of pending", () => {
    const line = renderSandboxTally({
      attached: 1,
      reattach: { detachedAtBoot: 3, reattached: 1, gone: 0, failed: 0, unserved: 2, pending: 0 },
    })
    expect(line).toContain("1 attached")
    expect(line).toContain("re-attached 1/1 sandbox session")
    expect(line).toContain("2 detached rows belong to other workspaces (not served by this daemon)")
    expect(line).not.toContain("still pending")
  })

  it("shows only the attached count when nothing was detached at boot", () => {
    const line = renderSandboxTally({
      attached: 2,
      reattach: { detachedAtBoot: 0, reattached: 0, gone: 0, failed: 0, pending: 0 },
    })
    expect(line).toContain("2 attached")
    expect(line).not.toContain("re-attached")
  })

  it("is absent on a daemon with no sandbox sessions at all", () => {
    expect(
      renderSandboxTally({
        attached: 0,
        reattach: { detachedAtBoot: 0, reattached: 0, gone: 0, failed: 0, pending: 0 },
      }),
    ).toBeNull()
  })
})
