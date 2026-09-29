import { describe, expect, it } from "vitest"
import {
  BrowserCrashLoopError,
  createBrowserSupervisor,
  defineBrowser,
  type BackendRestartEvent,
  type BrowserHealth,
  type BrowserInstance,
  type BrowserProvider,
  type SupervisorState,
} from "../index.js"
import { FakeClock } from "./fake-clock.js"

interface Harness {
  provider: BrowserProvider
  launches: () => number
  signals: AbortSignal[]
  health: { current: BrowserHealth }
  stops: () => number
}

/** `behaviour` decides each launch: throw, wait on the fake clock, or succeed. */
function makeProvider(
  clock: FakeClock,
  behaviour: (attempt: number) => { fail?: boolean; delayMs?: number },
): Harness {
  let launches = 0
  let stops = 0
  const signals: AbortSignal[] = []
  const health = {
    current: { ok: true, lifecycle: { bootId: "boot-1", browserState: "running" } } as BrowserHealth,
  }
  const provider = defineBrowser({
    id: "sup-fake",
    name: "Supervisor fake",
    description: "fake",
    version: "1.0.0",
    transport: "sdk",
    location: "local",
    async launch(_opts, ctx) {
      launches += 1
      const step = behaviour(launches)
      if (ctx.signal) signals.push(ctx.signal)
      if (step.delayMs) await new Promise<void>((r) => clock.setTimeout(r, step.delayMs ?? 0))
      if (step.fail) throw new Error(`launch ${launches} failed`)
      const instance: BrowserInstance = {
        id: `sup-fake:${launches}`,
        endpoints: { rest: "http://127.0.0.1:1" },
        pid: 900 + launches,
        wasAlreadyRunning: false,
        health: async () => health.current,
        attach: async () => {
          throw new Error("not used")
        },
        stop: async () => {
          stops += 1
        },
      }
      return instance
    },
  })
  return { provider, launches: () => launches, signals, health, stops: () => stops }
}

describe("supervisor: launch-loop detector", () => {
  it("flips to crash-looping after N failed starts, makes no further attempts, and restart() resets", async () => {
    const clock = new FakeClock()
    let healthy = false
    const h = makeProvider(clock, () => (healthy ? {} : { fail: true }))
    const states: SupervisorState[] = []
    const sup = createBrowserSupervisor({
      provider: h.provider,
      clock,
      crashLoop: { maxFailures: 3, windowMs: 60_000, retryDelayMs: 1_000 },
      onStateChange: (s) => states.push(s),
    })

    const first = await clock.settle(sup.start())
    expect(first.status).toBe("rejected")
    expect((first as PromiseRejectedResult).reason).toBeInstanceOf(BrowserCrashLoopError)
    expect(h.launches()).toBe(3)
    expect(sup.status().state).toBe("crash-looping")
    expect(sup.status().crashLoopSource).toBe("supervisor")

    // No further spawns: not on an explicit start(), not as time passes.
    const again = await clock.settle(sup.start())
    expect(again.status).toBe("rejected")
    await clock.advance(3_600_000)
    expect(h.launches()).toBe(3)
    expect(clock.pending()).toBe(0)

    // Explicit restart resets the counters and launches again.
    healthy = true
    const restarted = await clock.settle(sup.restart())
    expect(restarted.status).toBe("fulfilled")
    expect(h.launches()).toBe(4)
    expect(sup.status().state).toBe("running")
    expect(sup.status().recentFailures).toBe(0)
    expect(states).toContain("crash-looping")
    await sup.stop()
  })

  it("does not count a slow launch that finishes inside the budget", async () => {
    const clock = new FakeClock()
    const h = makeProvider(clock, () => ({ delayMs: 100_000 }))
    const sup = createBrowserSupervisor({ provider: h.provider, clock, launchBudgetMs: 120_000 })
    const result = await clock.settle(sup.start(), 5_000)
    expect(result.status).toBe("fulfilled")
    expect(h.launches()).toBe(1)
    expect(sup.status().recentFailures).toBe(0)
    expect(sup.status().state).toBe("running")
    expect(h.signals[0]?.aborted).toBe(false)
    await sup.stop()
  })

  it("counts a launch that outruns the budget as one failure and aborts it", async () => {
    const clock = new FakeClock()
    const h = makeProvider(clock, (n) => (n === 1 ? { delayMs: 500_000 } : {}))
    const sup = createBrowserSupervisor({ provider: h.provider, clock, launchBudgetMs: 120_000 })
    const result = await clock.settle(sup.start(), 5_000)
    expect(result.status).toBe("fulfilled")
    expect(h.launches()).toBe(2)
    expect(sup.status().recentFailures).toBe(1)
    expect(h.signals[0]?.aborted).toBe(true)
    await sup.stop()
  })
})

describe("supervisor: health loop and lifecycle fields", () => {
  it("fires onBackendRestart when the bootId changes", async () => {
    const clock = new FakeClock()
    const h = makeProvider(clock, () => ({}))
    const events: BackendRestartEvent[] = []
    const sup = createBrowserSupervisor({
      provider: h.provider,
      clock,
      healthIntervalMs: 10_000,
      onBackendRestart: (e) => events.push(e),
    })
    await clock.settle(sup.start())
    await clock.advance(10_000)
    expect(events).toHaveLength(0)

    h.health.current = {
      ok: true,
      lifecycle: { bootId: "boot-2", browserState: "running", lastRestartReason: "newcontext_timeout" },
    }
    await clock.advance(10_000)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      previousBootId: "boot-1",
      bootId: "boot-2",
      lastRestartReason: "newcontext_timeout",
    })
    await clock.advance(30_000)
    expect(events).toHaveLength(1)
    await sup.stop()
  })

  it("treats a 503 that reports crash-looping as a state, not as down, and does not relaunch", async () => {
    const clock = new FakeClock()
    const h = makeProvider(clock, () => ({}))
    const sup = createBrowserSupervisor({
      provider: h.provider,
      clock,
      healthIntervalMs: 10_000,
      unhealthyThreshold: 1,
    })
    await clock.settle(sup.start())
    h.health.current = {
      ok: false,
      reason: "503",
      lifecycle: { bootId: "boot-1", browserState: "crash-looping" },
    }
    await clock.advance(60_000)
    expect(sup.status().state).toBe("crash-looping")
    expect(sup.status().crashLoopSource).toBe("backend")
    expect(h.launches()).toBe(1)

    // Someone POSTs /start on the backend: the supervisor follows it back to running.
    h.health.current = { ok: true, lifecycle: { bootId: "boot-1", browserState: "running" } }
    await clock.advance(10_000)
    expect(sup.status().state).toBe("running")
    await sup.stop()
  })

  it("does not treat a progressing backend launch as down", async () => {
    const clock = new FakeClock()
    const h = makeProvider(clock, () => ({}))
    const sup = createBrowserSupervisor({
      provider: h.provider,
      clock,
      healthIntervalMs: 10_000,
      unhealthyThreshold: 1,
    })
    await clock.settle(sup.start())
    h.health.current = { ok: false, lifecycle: { bootId: "boot-1", browserState: "launching" } }
    await clock.advance(100_000)
    expect(sup.status().state).toBe("launching")
    expect(h.launches()).toBe(1)
    await sup.stop()
  })

  it("relaunches after the unhealthy threshold and reports idle", async () => {
    const clock = new FakeClock()
    const h = makeProvider(clock, () => ({}))
    const sup = createBrowserSupervisor({
      provider: h.provider,
      clock,
      healthIntervalMs: 10_000,
      unhealthyThreshold: 2,
    })
    await clock.settle(sup.start())
    h.health.current = { ok: true, lifecycle: { bootId: "boot-1", browserState: "idle" } }
    await clock.advance(10_000)
    expect(sup.status().state).toBe("idle")

    h.health.current = { ok: false, reason: "connection refused" }
    await clock.advance(10_000)
    expect(sup.status().state).toBe("down")
    expect(h.launches()).toBe(1)
    await clock.advance(10_000)
    expect(h.launches()).toBe(2)
    expect(h.stops()).toBe(1)
    await sup.stop()
    expect(clock.pending()).toBe(0)
  })
})

describe("supervisor: orphan sweep", () => {
  it("kills only marker-carrying processes from the injected lister, never a bystander or this process", async () => {
    const clock = new FakeClock()
    const h = makeProvider(clock, () => ({}))
    const killed: number[] = []
    const marker = "--agentproto-browser=work"
    const sup = createBrowserSupervisor({
      provider: h.provider,
      clock,
      orphanSweep: {
        marker,
        listProcesses: async () => [
          { pid: 10, command: `camoufox --headless ${marker}` },
          { pid: 11, command: `camoufox ${marker}1` },
          { pid: 12, command: "firefox --new-window" },
          { pid: 13, command: "camoufox --profile /tmp/x" },
          { pid: 14, command: `node ${marker} --other` },
          { pid: 901, command: `camoufox ${marker}` },
          { pid: process.pid, command: `node ${marker}` },
        ],
        kill: (pid) => {
          killed.push(pid)
        },
      },
    })
    await clock.settle(sup.start())
    await sup.stop()
    // 901 is the stopped instance's own leftover; process.pid is protected by default.
    expect(killed).toEqual([10, 14, 901])
  })
})
