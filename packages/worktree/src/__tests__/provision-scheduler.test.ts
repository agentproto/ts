import { describe, it, expect, vi } from "vitest"
import { homedir } from "node:os"
import { resolve } from "node:path"
import {
  DEFAULT_PROVISION_CONCURRENCY,
  DEFAULT_PROVISION_LIMITS,
  PROVISION_CONCURRENCY_ENV,
  ProvisionCancelledError,
  ProvisionScheduler,
  parseProvisionLimits,
  runWithProvisionContext,
  currentProvisionContext,
  type ProvisionLease,
  type ProvisionLimits,
} from "../provision-scheduler.js"

const limits = (over: Partial<ProvisionLimits> = {}): ProvisionLimits => ({
  concurrency: 2,
  perRepo: {},
  loadFactor: 0,
  ...over,
})

/** Let queued promise continuations run. */
const flush = (): Promise<void> => new Promise(r => setImmediate(r))

describe("parseProvisionLimits", () => {
  it("defaults to a cap of 2, no per-repo caps, load guard off", () => {
    expect(parseProvisionLimits(undefined, {})).toEqual({
      concurrency: DEFAULT_PROVISION_CONCURRENCY,
      perRepo: {},
      loadFactor: 0,
    })
    expect(DEFAULT_PROVISION_CONCURRENCY).toBe(2)
    expect(DEFAULT_PROVISION_LIMITS.concurrency).toBe(2)
  })

  it("reads provisionConcurrency, treating 0 as unlimited", () => {
    expect(parseProvisionLimits({ provisionConcurrency: 4 }, {}).concurrency).toBe(4)
    expect(parseProvisionLimits({ provisionConcurrency: 0 }, {}).concurrency).toBe(Infinity)
  })

  it("falls back to the default for invalid values instead of throwing", () => {
    for (const bad of [-1, 1.5, "lots", null, NaN, {}, []]) {
      expect(parseProvisionLimits({ provisionConcurrency: bad }, {}).concurrency).toBe(2)
    }
    expect(parseProvisionLimits("nonsense", {}).concurrency).toBe(2)
    expect(parseProvisionLimits(42, {}).concurrency).toBe(2)
  })

  it("lets the env override win over the config field", () => {
    const env = { [PROVISION_CONCURRENCY_ENV]: "3" }
    expect(parseProvisionLimits({ provisionConcurrency: 1 }, env).concurrency).toBe(3)
    expect(parseProvisionLimits({ provisionConcurrency: 1 }, { [PROVISION_CONCURRENCY_ENV]: "0" }).concurrency).toBe(
      Infinity,
    )
    // A garbage env value is ignored, not treated as a cap.
    expect(parseProvisionLimits({ provisionConcurrency: 1 }, { [PROVISION_CONCURRENCY_ENV]: "x" }).concurrency).toBe(1)
    expect(parseProvisionLimits({}, { [PROVISION_CONCURRENCY_ENV]: "" }).concurrency).toBe(2)
  })

  it("parses per-repo caps: bare names stay names, paths resolve, ~/ expands, bad entries drop", () => {
    const parsed = parseProvisionLimits(
      {
        provisionConcurrencyByRepo: {
          "agentik-studio": 1,
          "/srv/repos/big": 0,
          "~/code/mine": 3,
          bad: -2,
          alsoBad: "two",
          "  ": 1,
        },
      },
      {},
    )
    expect(parsed.perRepo).toEqual({
      "agentik-studio": 1,
      [resolve("/srv/repos/big")]: Infinity,
      [resolve(homedir(), "code/mine")]: 3,
    })
    expect(parseProvisionLimits({ provisionConcurrencyByRepo: [1, 2] }, {}).perRepo).toEqual({})
    expect(parseProvisionLimits({ provisionConcurrencyByRepo: "x" }, {}).perRepo).toEqual({})
  })

  it("parses the load factor: positive finite numbers enable it, everything else is off", () => {
    expect(parseProvisionLimits({ provisionLoadFactor: 1.5 }, {}).loadFactor).toBe(1.5)
    for (const off of [0, -1, "2", Infinity, NaN, undefined]) {
      expect(parseProvisionLimits({ provisionLoadFactor: off }, {}).loadFactor).toBe(0)
    }
  })
})

describe("ProvisionScheduler", () => {
  it("grants immediately while under the cap and never reports a queue position", async () => {
    const s = new ProvisionScheduler({ limits: limits() })
    const onQueued = vi.fn()
    const a = await s.acquire({ repoKey: "/r", onQueued })
    const b = await s.acquire({ repoKey: "/r", onQueued })
    expect(s.snapshot()).toEqual({ running: 2, queued: 0, limit: 2 })
    expect(onQueued).not.toHaveBeenCalled()
    a.release()
    b.release()
    expect(s.snapshot().running).toBe(0)
  })

  it("admits queued requests in FIFO order for a single caller", async () => {
    const s = new ProvisionScheduler({ limits: limits({ concurrency: 1 }) })
    const order: string[] = []
    const first = await s.acquire({ repoKey: "/r", callerKey: "c" })
    const leases: ProvisionLease[] = []
    const waiters = ["a", "b", "c", "d"].map(name =>
      s.acquire({ repoKey: "/r", callerKey: "c" }).then(lease => {
        order.push(name)
        leases.push(lease)
      }),
    )
    expect(s.snapshot()).toEqual({ running: 1, queued: 4, limit: 1 })
    first.release()
    for (let i = 0; i < 4; i++) {
      await flush()
      leases[i]!.release()
    }
    await Promise.all(waiters)
    expect(order).toEqual(["a", "b", "c", "d"])
  })

  it("never exceeds the cap under a burst of spawns", async () => {
    const s = new ProvisionScheduler({ limits: limits({ concurrency: 2 }) })
    let active = 0
    let peak = 0
    const finished: number[] = []
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        s.acquire({ repoKey: "/r", callerKey: `c${i % 3}` }).then(async lease => {
          active++
          peak = Math.max(peak, active)
          await new Promise(r => setTimeout(r, 5))
          active--
          finished.push(i)
          lease.release()
        }),
      ),
    )
    expect(peak).toBe(2)
    expect(finished).toHaveLength(12)
    expect(s.snapshot()).toEqual({ running: 0, queued: 0, limit: 2 })
  })

  it("dispatches fairly across callers: a caller holding fewer slots goes ahead of an older waiter", async () => {
    const s = new ProvisionScheduler({ limits: limits({ concurrency: 2 }) })
    const order: string[] = []
    const a = await s.acquire({ repoKey: "/r", callerKey: "chatty" })
    await s.acquire({ repoKey: "/r", callerKey: "chatty" })
    const leases = new Map<string, ProvisionLease>()
    const req = (name: string, callerKey: string) =>
      s.acquire({ repoKey: "/r", callerKey }).then(lease => {
        order.push(name)
        leases.set(name, lease)
      })
    const all = [req("chatty-3", "chatty"), req("quiet-1", "quiet")]
    a.release() // one slot frees; chatty still holds 1, quiet holds 0
    await flush()
    expect(order).toEqual(["quiet-1"])
    leases.get("quiet-1")!.release()
    await flush()
    expect(order).toEqual(["quiet-1", "chatty-3"])
    leases.get("chatty-3")!.release()
    await Promise.all(all)
  })

  it("reports the projected queue position and updates it as the queue drains", async () => {
    const s = new ProvisionScheduler({ limits: limits({ concurrency: 1 }) })
    const held = await s.acquire({ repoKey: "/r", callerKey: "c" })
    const positions: Record<string, number[]> = { a: [], b: [], c: [] }
    const leases = new Map<string, ProvisionLease>()
    const req = (name: string) =>
      s
        .acquire({ repoKey: "/r", callerKey: "c", onQueued: p => positions[name]!.push(p) })
        .then(lease => leases.set(name, lease))
    const all = [req("a"), req("b"), req("c")]
    expect(positions).toEqual({ a: [1], b: [2], c: [3] })
    held.release()
    await flush()
    expect(positions).toEqual({ a: [1], b: [2, 1], c: [3, 2] })
    leases.get("a")!.release()
    await flush()
    expect(positions).toEqual({ a: [1], b: [2, 1], c: [3, 2, 1] })
    leases.get("b")!.release()
    await flush()
    leases.get("c")!.release()
    await Promise.all(all)
  })

  it("drops a queued request when its signal aborts: it never holds a slot and frees its position", async () => {
    const s = new ProvisionScheduler({ limits: limits({ concurrency: 1 }) })
    const held = await s.acquire({ repoKey: "/r", callerKey: "c" })
    const ac = new AbortController()
    const positions: number[] = []
    const cancelled = s.acquire({ repoKey: "/r", callerKey: "c", signal: ac.signal })
    const survivor = s.acquire({ repoKey: "/r", callerKey: "c", onQueued: p => positions.push(p) })
    expect(positions).toEqual([2])
    ac.abort()
    await expect(cancelled).rejects.toBeInstanceOf(ProvisionCancelledError)
    expect(s.snapshot()).toEqual({ running: 1, queued: 1, limit: 1 })
    expect(positions).toEqual([2, 1])
    held.release()
    const lease = await survivor
    expect(s.snapshot()).toEqual({ running: 1, queued: 0, limit: 1 })
    lease.release()
    expect(s.snapshot().running).toBe(0)
  })

  it("rejects immediately for an already-aborted signal and never queues", async () => {
    const s = new ProvisionScheduler({ limits: limits() })
    const ac = new AbortController()
    ac.abort()
    await expect(s.acquire({ repoKey: "/r", signal: ac.signal })).rejects.toBeInstanceOf(ProvisionCancelledError)
    expect(s.snapshot()).toEqual({ running: 0, queued: 0, limit: 2 })
  })

  it("aborting AFTER the slot was granted does not disturb the lease", async () => {
    const s = new ProvisionScheduler({ limits: limits({ concurrency: 1 }) })
    const ac = new AbortController()
    const lease = await s.acquire({ repoKey: "/r", signal: ac.signal })
    ac.abort()
    expect(s.snapshot().running).toBe(1)
    lease.release()
    expect(s.snapshot().running).toBe(0)
  })

  it("release is idempotent and cannot free a slot twice", async () => {
    const s = new ProvisionScheduler({ limits: limits({ concurrency: 1 }) })
    const a = await s.acquire({ repoKey: "/r" })
    const waiting = s.acquire({ repoKey: "/r" })
    a.release()
    a.release()
    const b = await waiting
    // A stale double-release of `a` must not have freed b's slot for a third.
    const third = vi.fn()
    void s.acquire({ repoKey: "/r" }).then(third)
    await flush()
    expect(third).not.toHaveBeenCalled()
    b.release()
    await flush()
    expect(third).toHaveBeenCalledOnce()
  })

  it("enforces a per-repo cap without blocking other repos behind it", async () => {
    const s = new ProvisionScheduler({
      limits: limits({ concurrency: 3, perRepo: { studio: 1 } }),
    })
    const order: string[] = []
    const leases = new Map<string, ProvisionLease>()
    const req = (name: string, repoKey: string) =>
      s.acquire({ repoKey, callerKey: name }).then(lease => {
        order.push(name)
        leases.set(name, lease)
      })
    const all = [
      req("studio-1", "/code/studio"),
      req("studio-2", "/code/studio"),
      req("other-1", "/code/other"),
    ]
    await flush()
    // studio-2 is capped (1 per repo) and must not hold up other-1.
    expect(order).toEqual(["studio-1", "other-1"])
    expect(s.snapshot()).toEqual({ running: 2, queued: 1, limit: 3 })
    leases.get("studio-1")!.release()
    await flush()
    expect(order).toEqual(["studio-1", "other-1", "studio-2"])
    leases.get("studio-2")!.release()
    leases.get("other-1")!.release()
    await Promise.all(all)
  })

  it("matches a per-repo cap by absolute path as well as by directory name", async () => {
    const s = new ProvisionScheduler({ limits: limits({ concurrency: 5, perRepo: { "/code/studio": 1 } }) })
    await s.acquire({ repoKey: "/code/studio" })
    const second = vi.fn()
    void s.acquire({ repoKey: "/code/studio" }).then(second)
    await flush()
    expect(second).not.toHaveBeenCalled()
  })

  it("a per-repo cap can never exceed the global cap", async () => {
    const s = new ProvisionScheduler({ limits: limits({ concurrency: 1, perRepo: { big: 10 } }) })
    await s.acquire({ repoKey: "/x/big" })
    const second = vi.fn()
    void s.acquire({ repoKey: "/x/big" }).then(second)
    await flush()
    expect(second).not.toHaveBeenCalled()
  })

  it("ignores prototype keys when resolving a repo cap", async () => {
    const s = new ProvisionScheduler({ limits: limits({ concurrency: 2 }) })
    await s.acquire({ repoKey: "/x/constructor" })
    const second = vi.fn()
    void s.acquire({ repoKey: "/x/constructor" }).then(second)
    await flush()
    expect(second).toHaveBeenCalledOnce()
  })

  it("configure() with a higher cap admits waiting requests immediately", async () => {
    const s = new ProvisionScheduler({ limits: limits({ concurrency: 1 }) })
    await s.acquire({ repoKey: "/r" })
    const admitted = vi.fn()
    void s.acquire({ repoKey: "/r" }).then(admitted)
    await flush()
    expect(admitted).not.toHaveBeenCalled()
    s.configure(limits({ concurrency: 2 }))
    await flush()
    expect(admitted).toHaveBeenCalledOnce()
  })

  it("configure() with a lower cap never interrupts running segments, it delays the next", async () => {
    const s = new ProvisionScheduler({ limits: limits({ concurrency: 3 }) })
    const a = await s.acquire({ repoKey: "/r" })
    const b = await s.acquire({ repoKey: "/r" })
    s.configure(limits({ concurrency: 1 }))
    expect(s.snapshot().running).toBe(2)
    const next = vi.fn()
    void s.acquire({ repoKey: "/r" }).then(next)
    a.release()
    await flush()
    expect(next).not.toHaveBeenCalled() // still 1 running == cap
    b.release()
    await flush()
    expect(next).toHaveBeenCalledOnce()
  })

  it("an unlimited cap (Infinity) never queues", async () => {
    const s = new ProvisionScheduler({ limits: limits({ concurrency: Infinity }) })
    for (let i = 0; i < 20; i++) await s.acquire({ repoKey: "/r" })
    expect(s.snapshot().queued).toBe(0)
    expect(s.snapshot().running).toBe(20)
  })

  describe("load guard", () => {
    it("holds back a new segment while loadavg exceeds cores x factor, then admits it once load drops", async () => {
      let load = 12
      const s = new ProvisionScheduler({
        limits: limits({ concurrency: 4, loadFactor: 1 }),
        loadavg1: () => load,
        cpuCount: () => 8,
        loadPollMs: 5,
      })
      const first = await s.acquire({ repoKey: "/r" }) // idle scheduler: never blocked
      const second = vi.fn()
      void s.acquire({ repoKey: "/r" }).then(second)
      await flush()
      expect(second).not.toHaveBeenCalled()
      expect(s.snapshot()).toEqual({ running: 1, queued: 1, limit: 4 })
      load = 3
      await vi.waitFor(() => expect(second).toHaveBeenCalledOnce(), { timeout: 2000 })
      first.release()
    })

    it("never deadlocks a permanently loaded host: an idle scheduler always admits one", async () => {
      const s = new ProvisionScheduler({
        limits: limits({ concurrency: 4, loadFactor: 0.5 }),
        loadavg1: () => 999,
        cpuCount: () => 2,
        loadPollMs: 5,
      })
      const lease = await s.acquire({ repoKey: "/r" })
      const queued = vi.fn()
      void s.acquire({ repoKey: "/r" }).then(queued)
      await flush()
      expect(queued).not.toHaveBeenCalled()
      lease.release() // nothing running now: the waiter is admitted despite the load
      await flush()
      expect(queued).toHaveBeenCalledOnce()
    })

    it("is off by default: high load never delays admission", async () => {
      const s = new ProvisionScheduler({
        limits: limits({ concurrency: 4 }),
        loadavg1: () => 999,
        cpuCount: () => 1,
      })
      await s.acquire({ repoKey: "/r" })
      await s.acquire({ repoKey: "/r" })
      expect(s.snapshot().running).toBe(2)
    })

    it("a cancelled load-guarded waiter leaves no live timer behind", async () => {
      const s = new ProvisionScheduler({
        limits: limits({ concurrency: 4, loadFactor: 1 }),
        loadavg1: () => 999,
        cpuCount: () => 1,
        loadPollMs: 1_000_000,
      })
      await s.acquire({ repoKey: "/r" })
      const ac = new AbortController()
      const waiting = s.acquire({ repoKey: "/r", signal: ac.signal })
      ac.abort()
      await expect(waiting).rejects.toBeInstanceOf(ProvisionCancelledError)
      expect(s.snapshot().queued).toBe(0)
    })
  })
})

describe("provision run context", () => {
  it("is visible inside runWithProvisionContext (including across awaits) and absent outside", async () => {
    expect(currentProvisionContext()).toBeUndefined()
    const ac = new AbortController()
    await runWithProvisionContext({ callerKey: "caller-1", signal: ac.signal }, async () => {
      await flush()
      const ctx = currentProvisionContext()
      expect(ctx?.callerKey).toBe("caller-1")
      expect(ctx?.signal).toBe(ac.signal)
    })
    expect(currentProvisionContext()).toBeUndefined()
  })
})
