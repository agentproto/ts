/**
 * Sandbox proxy — no-lost-work behaviors (FAKE TIMERS).
 *
 * 1. DEADLINE-BOUNDED FINAL CHECKPOINT: when a box approaches its lifetime
 *    deadline, the final checkpoint must be bounded to (deadline - now -
 *    margin) so it can never outlive the box (the e2b "sandbox not found"
 *    loss, 2026-10-20) — and be SKIPPED once the remaining window is smaller
 *    than the margin (no checkpoint can finish).
 * 2. HOST-SIDE RESCUE PUSH on a wedged low-disk session: a forced low-disk
 *    checkpoint whose outcome does NOT prove the work is safe outside the
 *    box triggers `checkpoint.rescue(sessionId)` and surfaces the branch.
 * 3. DEATH RELEASE: `close({ deathRelease: true })` on a pause-lifecycle box
 *    must REALLY release it (stop), never pause it — a RAM-held box for a
 *    dead session wedged a whole provider's capacity ("available 511").
 */

import { describe, it, expect, vi, afterEach, type Mock } from "vitest"
import {
  createSandboxAgentSessionProxy,
  type SandboxAgentSessionProxyOpts,
  BOX_DEADLINE_GUARD_LEAD_MS,
} from "../sandbox-agent-session-proxy.js"
import {
  DEFAULT_CHECKPOINT_DEADLINE_MS,
  type SandboxCheckpointerRunOpts,
} from "../sandbox-delivery.js"

type FakeHost = Parameters<typeof createSandboxAgentSessionProxy>[0]["host"]

function makeHost(overrides: Partial<FakeHost> = {}): FakeHost {
  return {
    prompt: vi.fn(async () => {}),
    interrupt: vi.fn(async () => ({ wasBusy: false })),
    output: vi.fn(async () => ""),
    kill: vi.fn(async () => {}),
    waitForAny: vi.fn(async () => ({ timedOut: false, event: "turn-end" as const, sessionIds: [] })),
    currentEventsCursor: vi.fn(async () => 0),
    stop: vi.fn(async () => {}),
    mcpUrl: "http://127.0.0.1:18790/mcp",
    ...overrides,
  }
}

/** `df -Pk /` for a nearly full box (0.1% free) — the disk guard trips. */
const dfFullExec: FakeHost["exec"] = vi.fn(async () => ({
  exitCode: 0,
  stdout:
    "Filesystem 1024-blocks Used Available Capacity Mounted on\n" +
    "/dev/sda1 1000000 999001 999 100% /\n",
  stderr: "",
  durationMs: 1,
}))

describe("sandbox proxy — deadline-bounded final checkpoint (fake timers)", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("an idle box's final checkpoint is bounded to the remaining lifetime minus the margin", async () => {
    vi.useFakeTimers()
    const LIFETIME_MS = 45 * 60_000
    const checkpoint: Mock = vi.fn(async (_turn?: number, _opts?: SandboxCheckpointerRunOpts) => ({}))
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost({ lifetimeMs: LIFETIME_MS, extendTimeout: vi.fn(async () => {}) }),
      remoteSessionId: "remote_1",
      checkpoint: { run: checkpoint, intervalMs: 10 * 60_000, periodic: false },
    })
    // The guard fires BOX_DEADLINE_GUARD_LEAD_MS early — at that instant
    // exactly `lead` ms remain before the reaper, so the bound must be
    // lead - margin (300k - 90k = 210k), never the default 300k.
    await vi.advanceTimersByTimeAsync(LIFETIME_MS - BOX_DEADLINE_GUARD_LEAD_MS)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    const opts = checkpoint.mock.calls[0]![1] as { deadlineMs?: number } | undefined
    expect(opts?.deadlineMs).toBe(BOX_DEADLINE_GUARD_LEAD_MS - 90_000)
    expect(opts?.deadlineMs).toBeLessThanOrEqual(DEFAULT_CHECKPOINT_DEADLINE_MS)
    // After the deadline, nothing more runs.
    await vi.advanceTimersByTimeAsync(BOX_DEADLINE_GUARD_LEAD_MS)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    await proxy.close().catch(() => undefined)
  })

  it("skips the final checkpoint entirely when less than the margin remains", async () => {
    vi.useFakeTimers()
    // 60s lifetime → lead = min(5min, 20s) = 20s, so the bounded window at
    // fire time is 20s - 90s < 0 : no checkpoint could finish in time.
    const checkpoint = vi.fn(async () => ({}))
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost({ lifetimeMs: 60_000, extendTimeout: vi.fn(async () => {}) }),
      remoteSessionId: "remote_1",
      checkpoint: { run: checkpoint, intervalMs: 10 * 60_000, periodic: false },
    })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(checkpoint).not.toHaveBeenCalled()
    await proxy.close().catch(() => undefined)
  })

  it("retries a failed in-turn renewal instead of racing the reaper, then still bounds the final checkpoint", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("unreachable"))))
    const LIFETIME_MS = 45 * 60_000
    const checkpoint = vi.fn(async () => ({}))
    const extendTimeout = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("quota"))
      .mockResolvedValue(undefined)
    const host = makeHost({
      extendTimeout,
      lifetimeMs: LIFETIME_MS,
      waitForAny: vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 49_000))
        return { timedOut: true, sessionIds: [] }
      }),
    })
    const proxy = createSandboxAgentSessionProxy({
      host,
      remoteSessionId: "remote_1",
      checkpoint: { run: checkpoint, intervalMs: 10 * 60_000, periodic: false },
    })
    // A turn that never ends — the guard's renewal loop must retry, not
    // fall through to a checkpoint past the deadline.
    void (async () => {
      for await (const _evt of proxy.send("go")) {
        // never yields
      }
    })().catch(() => undefined)
    await vi.advanceTimersByTimeAsync(LIFETIME_MS - BOX_DEADLINE_GUARD_LEAD_MS)
    // First attempt at the guard fired and failed; the spaced retry ran.
    expect(extendTimeout.mock.calls.length).toBeGreaterThanOrEqual(2)
    // The retry succeeded → the guard re-armed a full lifetime later and the
    // turn continued: still NO final checkpoint and the box was NOT stopped.
    expect(checkpoint).not.toHaveBeenCalled()
    expect(host.stop).not.toHaveBeenCalled()
    // The guard re-arm must have moved the deadline a full lifetime ahead:
    // another near-window advance must retry again (and still checkpoint
    // nothing — the renewal keeps landing).
    await vi.advanceTimersByTimeAsync(LIFETIME_MS - BOX_DEADLINE_GUARD_LEAD_MS)
    expect(extendTimeout.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(checkpoint).not.toHaveBeenCalled()
    await proxy.close().catch(() => undefined)
  })
})

describe("sandbox proxy — host-side rescue push on a wedged low-disk session (fake timers)", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function makeProxy(
    host: FakeHost,
    overrides: Partial<SandboxAgentSessionProxyOpts> = {},
  ): { proxy: ReturnType<typeof createSandboxAgentSessionProxy>; checkpoint: ReturnType<typeof vi.fn> } {
    const checkpoint = vi.fn(async () => ({}))
    const proxy = createSandboxAgentSessionProxy({
      host,
      remoteSessionId: "remote_1",
      checkpoint: { run: checkpoint as never, intervalMs: 10 * 60_000 },
      ...overrides,
    })
    return { proxy, checkpoint }
  }

  it("a low-disk checkpoint whose outcome proved nothing runs the rescue and names the branch", async () => {
    vi.useFakeTimers()
    const rescue = vi.fn(async (sessionId: string) => ({ rescueBranch: `rescue/${sessionId}` }))
    const onWarning = vi.fn()
    // checkpoint resolves "unchanged: restored" is falsy here: it resolves an
    // empty object — no pushedGit, no saved tarball → work NOT secured.
    const { proxy } = makeProxy(makeHost({ exec: dfFullExec }), {
      onWarning,
      checkpoint: {
        run: vi.fn(async () => ({} as never)),
        intervalMs: 10 * 60_000,
        rescue,
      } as never,
    })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(rescue).toHaveBeenCalledTimes(1)
    expect(rescue.mock.calls[0]![0]).toBe("remote_1")
    expect(onWarning).toHaveBeenCalledTimes(2) // + the disk-guard warning
    expect(onWarning.mock.calls[1]![0]).toContain("rescue/remote_1")
    await proxy.close().catch(() => undefined)
  })

  it("a checkpoint that did NOT deliver (failed) also rescues", async () => {
    vi.useFakeTimers()
    const rescue = vi.fn(async () => ({ rescueBranch: "rescue/remote_1" }))
    const onWarning = vi.fn()
    const { proxy } = makeProxy(makeHost({ exec: dfFullExec }), {
      onWarning,
      checkpoint: {
        run: vi.fn(async () => ({ status: "failed" } as never)),
        intervalMs: 10 * 60_000,
        rescue,
      } as never,
    })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(rescue).toHaveBeenCalledTimes(1)
    await proxy.close().catch(() => undefined)
  })

  it("a delivery that already secured the work rescues nothing", async () => {
    vi.useFakeTimers()
    const rescue = vi.fn(async () => ({ rescueBranch: "rescue/remote_1" }))
    const { proxy } = makeProxy(makeHost({ exec: dfFullExec }), {
      checkpoint: {
        run: vi.fn(async () => ({ unchanged: true, key: "k" } as never)),
        intervalMs: 10 * 60_000,
        rescue,
      } as never,
    })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(rescue).not.toHaveBeenCalled()
    await proxy.close().catch(() => undefined)
  })

  it("no rescue slot wired ⇒ no rescue, warning or crash", async () => {
    vi.useFakeTimers()
    const { proxy, checkpoint } = makeProxy(makeHost({ exec: dfFullExec }))
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(checkpoint).toHaveBeenCalledWith(0, { force: true })
    await proxy.close().catch(() => undefined)
  })
})

describe("sandbox proxy — death release (fake timers)", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("close({ deathRelease: true }) stops a pause-lifecycle box instead of pausing it", async () => {
    vi.useFakeTimers()
    const pause = vi.fn(async () => {})
    const stop = vi.fn(async () => {})
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost({ pause, stop }),
      remoteSessionId: "remote_1",
      lifecyclePolicy: { teardown: "pause" },
    })
    await (proxy.close as unknown as (o?: { deathRelease?: boolean }) => Promise<void>)({
      deathRelease: true,
    })
    expect(pause).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalled()
  })

  it("a plain close() on the same policy still pauses (reuse-by-design is untouched)", async () => {
    vi.useFakeTimers()
    const pause = vi.fn(async () => {})
    const stop = vi.fn(async () => {})
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost({ pause, stop }),
      remoteSessionId: "remote_2",
      lifecyclePolicy: { teardown: "pause" },
    })
    await proxy.close()
    expect(pause).toHaveBeenCalled()
    await proxy.close().catch(() => undefined)
  })
})

