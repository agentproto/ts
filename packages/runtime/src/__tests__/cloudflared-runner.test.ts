import { describe, expect, it } from "vitest"

import { CloudflaredRunner } from "../remote-providers/cloudflared-runner.js"
import type { FetchLike } from "../remote-providers/cloudflare-api.js"
import type { PublicDns } from "../remote-providers/dns-resolver.js"
import type {
  ProcessSpawner,
  SpawnRequest,
  SupervisedProcess,
} from "../remote-providers/process-supervisor.js"

// --- fakes --------------------------------------------------------------

class FakeProc implements SupervisedProcess {
  readonly pid = 4242
  private cbs: Array<(c: number | null, s: NodeJS.Signals | null) => void> = []
  kill(signal?: NodeJS.Signals): void {
    this.cbs.forEach(cb => cb(null, signal ?? "SIGTERM"))
  }
  onExit(cb: (c: number | null, s: NodeJS.Signals | null) => void): void {
    this.cbs.push(cb)
  }
}

function fakeSpawner() {
  const procs: FakeProc[] = []
  const requests: SpawnRequest[] = []
  const spawner: ProcessSpawner = req => {
    requests.push(req)
    const p = new FakeProc()
    procs.push(p)
    return p
  }
  return { spawner, procs, requests }
}

function respond(status: number) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => "",
  }
}

/** Probe fetch that walks a fixed status list, repeating the last entry. */
function sequenceProbe(statuses: number[]) {
  let calls = 0
  const probeFetch: FetchLike = async () => {
    const status = statuses[Math.min(calls, statuses.length - 1)] ?? 404
    calls++
    return respond(status)
  }
  return {
    probeFetch,
    calls: () => calls,
  }
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}

/** Manual clock + timer queue; advance() drains due timers and their probes. */
function fakeTimers() {
  let now = 0
  const queue: Array<{ at: number; fn: () => void; cancelled: boolean }> = []
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn, cancelled: false }
      queue.push(t)
      return () => {
        t.cancelled = true
      }
    },
    async advance(ms: number) {
      now += ms
      for (;;) {
        const t = queue.find(x => !x.cancelled && x.at <= now)
        if (!t) return
        t.cancelled = true
        t.fn()
        await flush()
      }
    },
  }
}

function makeRunner(
  statuses: number[],
  timers: ReturnType<typeof fakeTimers>,
  settleDelaysMs: readonly number[] = [2_000, 4_000],
) {
  const sp = fakeSpawner()
  const probe = sequenceProbe(statuses)
  const health: Array<{ state: string; reason?: string }> = []
  const runner = new CloudflaredRunner({
    spawner: sp.spawner,
    probeFetch: probe.probeFetch,
    healthIntervalMs: 60_000,
    publicDns: false,
    settleDelaysMs,
    setTimer: timers.setTimer,
    supervisor: { initialBackoffMs: 10, maxRestarts: 2 },
  })
  return { sp, probe, health, runner }
}

const START = {
  token: "connector-secret",
  hostnames: ["wa.example.com"],
  workspace: "/nonexistent",
  label: "wa",
}

// --- settle window ------------------------------------------------------

describe("CloudflaredRunner settle window", () => {
  it("re-probes on the short ladder and turns active long before healthIntervalMs", async () => {
    const timers = fakeTimers()
    const { probe, health, runner } = makeRunner([530, 404], timers)

    runner.start({ ...START, onHealth: h => health.push(h) })
    await flush()
    expect(probe.calls()).toBe(1)
    expect(runner.health()).toMatchObject({ state: "degraded" })

    await timers.advance(2_000)

    expect(probe.calls()).toBe(2)
    expect(runner.health()).toMatchObject({ state: "active" })
    expect(health.at(-1)?.state).toBe("active")
    expect(timers.now()).toBeLessThan(60_000)
    await runner.stop()
  })

  it("reports 'connecting to the Cloudflare edge' while settling, then today's reason", async () => {
    const timers = fakeTimers()
    const { runner } = makeRunner([530], timers)

    runner.start(START)
    await flush()
    expect(runner.health()).toMatchObject({
      state: "degraded",
      reason: "wa.example.com: connecting to the Cloudflare edge",
    })

    await timers.advance(2_000)
    expect(runner.health()).toMatchObject({
      state: "degraded",
      reason: "wa.example.com: connecting to the Cloudflare edge",
    })

    // Ladder exhausted (2s + 4s), so the pre-settle reason comes back.
    await timers.advance(4_000)
    expect(runner.health()).toMatchObject({
      state: "degraded",
      reason: "wa.example.com: edge returned 530",
    })
    await runner.stop()
  })

  it("anchors the first DNS-visible probe on the dnsPending start path", async () => {
    const timers = fakeTimers()
    const sp = fakeSpawner()
    const probe = sequenceProbe([530])
    let dnsCalls = 0
    const publicDns: PublicDns = {
      resolve: async () =>
        ++dnsCalls === 1
          ? { kind: "no-answer" }
          : { kind: "answer", addresses: ["203.0.113.10"] },
      pinnedFetch: () => probe.probeFetch,
      systemLookup: async () => ["203.0.113.10"],
    }
    const runner = new CloudflaredRunner({
      spawner: sp.spawner,
      probeFetch: probe.probeFetch,
      healthIntervalMs: 60_000,
      publicDns,
      dnsRetrySleep: async () => {},
      settleDelaysMs: [2_000, 4_000],
      setTimer: timers.setTimer,
      supervisor: { initialBackoffMs: 10, maxRestarts: 2 },
    })

    runner.start({ ...START, dnsPending: true })
    for (let i = 0; i < 20 && runner.health()?.reason !== "wa.example.com: connecting to the Cloudflare edge"; i++) {
      await flush()
    }

    expect(runner.health()).toMatchObject({
      state: "degraded",
      reason: "wa.example.com: connecting to the Cloudflare edge",
    })
    await runner.stop()
  })

  it("stop() during the settle window cancels the pending re-probe", async () => {
    const timers = fakeTimers()
    const { probe, runner } = makeRunner([530], timers)

    runner.start(START)
    await flush()
    expect(probe.calls()).toBe(1)

    await runner.stop()
    const afterStop = probe.calls()
    await timers.advance(100_000)
    expect(probe.calls()).toBe(afterStop)
  })
})
