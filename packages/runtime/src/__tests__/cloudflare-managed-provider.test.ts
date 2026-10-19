import { describe, expect, it } from "vitest"

import {
  ProcessSupervisor,
  type ProcessSpawner,
  type SpawnRequest,
  type SupervisedProcess,
} from "../remote-providers/process-supervisor.js"
import {
  cloudflareManagedTunnelProvider,
  probeHostname,
  MANAGED_CAPABILITIES,
} from "../remote-providers/cloudflare-managed.js"
import type { FetchLike } from "../remote-providers/cloudflare-api.js"
import { TunnelStartAbortedError, type TunnelHealth } from "../remote-providers/types.js"
import { FakeCloudflare } from "./helpers/fake-cloudflare.js"

// ── fakes ────────────────────────────────────────────────────────────────

class FakeProc implements SupervisedProcess {
  static next = 100
  readonly pid = FakeProc.next++
  killed: string[] = []
  private cbs: Array<(c: number | null, s: NodeJS.Signals | null) => void> = []
  exited = false
  kill(signal?: NodeJS.Signals): void {
    this.killed.push(signal ?? "SIGTERM")
    this.exit(null, signal ?? "SIGTERM")
  }
  onExit(cb: (c: number | null, s: NodeJS.Signals | null) => void): void {
    this.cbs.push(cb)
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return
    this.exited = true
    this.cbs.forEach(cb => cb(code, signal))
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

/** Manual clock + timer queue. */
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
    advance(ms: number) {
      now += ms
      for (const t of [...queue]) {
        if (!t.cancelled && t.at <= now) {
          t.cancelled = true
          t.fn()
        }
      }
    },
    pending: () => queue.filter(t => !t.cancelled).map(t => t.at - now),
  }
}

function probeFetch(statusByHost: Record<string, number | Error>): FetchLike {
  return async input => {
    const host = new URL(input).hostname
    const v = statusByHost[host] ?? 404
    if (v instanceof Error) throw v
    return {
      status: v,
      ok: v < 400,
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => "",
    }
  }
}

// ── supervisor ───────────────────────────────────────────────────────────

describe("ProcessSupervisor", () => {
  it("restarts a crashed child with exponential backoff", () => {
    const { spawner, procs } = fakeSpawner()
    const timers = fakeTimers()
    const states: string[] = []
    const sup = new ProcessSupervisor({
      spawner,
      request: { args: ["run"], env: {} },
      initialBackoffMs: 1000,
      maxBackoffMs: 4000,
      maxRestarts: 10,
      now: timers.now,
      setTimer: timers.setTimer,
      onState: s => states.push(s),
    })
    sup.start()
    expect(sup.state).toBe("running")

    procs[0]!.exit(1)
    expect(sup.state).toBe("restarting")
    expect(timers.pending()).toEqual([1000])
    timers.advance(1000)
    expect(procs).toHaveLength(2)
    expect(sup.state).toBe("running")

    procs[1]!.exit(1)
    expect(timers.pending()).toEqual([2000])
    timers.advance(2000)
    procs[2]!.exit(1)
    expect(timers.pending()).toEqual([4000])
    timers.advance(4000)
    procs[3]!.exit(1)
    expect(timers.pending()).toEqual([4000]) // capped
    expect(sup.restarts).toBe(3)
  })

  it("gives up after a crash loop and reports failed", () => {
    const { spawner, procs } = fakeSpawner()
    const timers = fakeTimers()
    let detail = ""
    const sup = new ProcessSupervisor({
      spawner,
      request: { args: [], env: {} },
      initialBackoffMs: 10,
      maxRestarts: 2,
      crashWindowMs: 60_000,
      now: timers.now,
      setTimer: timers.setTimer,
      onState: (_s, d) => (detail = d),
    })
    sup.start()
    procs[0]!.exit(1)
    timers.advance(10)
    procs[1]!.exit(1)
    timers.advance(20)
    procs[2]!.exit(1)
    expect(sup.state).toBe("failed")
    expect(detail).toMatch(/crash loop: 2 restarts/)
    expect(timers.pending()).toEqual([])
  })

  it("a long healthy run resets the backoff", () => {
    const { spawner, procs } = fakeSpawner()
    const timers = fakeTimers()
    const sup = new ProcessSupervisor({
      spawner,
      request: { args: [], env: {} },
      initialBackoffMs: 1000,
      stableAfterMs: 60_000,
      now: timers.now,
      setTimer: timers.setTimer,
    })
    sup.start()
    procs[0]!.exit(1)
    timers.advance(1000)
    timers.advance(120_000)
    procs[1]!.exit(1)
    expect(timers.pending()).toEqual([1000])
  })

  it("stop() kills the child and never restarts it", async () => {
    const { spawner, procs } = fakeSpawner()
    const timers = fakeTimers()
    const sup = new ProcessSupervisor({
      spawner,
      request: { args: [], env: {} },
      now: timers.now,
      setTimer: timers.setTimer,
    })
    sup.start()
    await sup.stop()
    expect(procs[0]!.killed).toEqual(["SIGTERM"])
    expect(sup.state).toBe("stopped")
    timers.advance(10 * 60_000)
    expect(procs).toHaveLength(1)
  })
})

// ── probe ────────────────────────────────────────────────────────────────

describe("probeHostname", () => {
  it("treats any app answer as healthy and edge 5xx / network errors as not", async () => {
    const f = probeFetch({
      "a.example.com": 401,
      "b.example.com": 404,
      "c.example.com": 530,
      "d.example.com": 502,
      "e.example.com": new Error("ENOTFOUND"),
    })
    expect((await probeHostname(f, "a.example.com")).ok).toBe(true)
    expect((await probeHostname(f, "b.example.com")).ok).toBe(true)
    expect(await probeHostname(f, "c.example.com")).toMatchObject({ ok: false, reason: "edge returned 530" })
    expect((await probeHostname(f, "d.example.com")).ok).toBe(false)
    expect(await probeHostname(f, "e.example.com")).toMatchObject({ ok: false, reason: /ENOTFOUND/ })
  })
})

// ── provider ─────────────────────────────────────────────────────────────

const CREDS = {
  zones: JSON.stringify([
    { zone: "example.com", accountId: "acct-a", tokenRef: "stored:examplecom" },
    { zone: "example.dev", accountId: "acct-a", tokenRef: "stored:exampledev" },
  ]),
  zoneTokens: JSON.stringify({ examplecom: "tok-examplecom", exampledev: "tok-exampledev" }),
}

function makeProvider(probeStatus: Record<string, number | Error> = {}) {
  const cf = new FakeCloudflare([
    { id: "zone-examplecom", name: "example.com", account: "acct-a", token: "tok-examplecom" },
    { id: "zone-exampledev", name: "example.dev", account: "acct-a", token: "tok-exampledev" },
  ])
  const sp = fakeSpawner()
  const timers = fakeTimers()
  const status = { ...probeStatus }
  const provider = cloudflareManagedTunnelProvider(CREDS, {
    fetch: cf.fetch,
    probeFetch: probeFetch(status),
    spawner: sp.spawner,
    healthIntervalMs: 0,
    supervisor: { now: timers.now, setTimer: timers.setTimer, initialBackoffMs: 10, maxRestarts: 2 },
  })
  return { cf, sp, timers, provider, status }
}

describe("cloudflareManagedTunnelProvider", () => {
  it("declares API-driven, stable capabilities and its setup fields", () => {
    const p = cloudflareManagedTunnelProvider(null)
    expect(p.slug).toBe("cloudflare-managed")
    expect(p.capabilities).toEqual(MANAGED_CAPABILITIES)
    expect(p.capabilities.hasApi).toBe(true)
    expect(p.setupFields?.map(f => f.name)).toEqual(["zones", "zoneTokens"])
    expect(p.setupFields?.find(f => f.name === "zoneTokens")?.sensitive).toBe(true)
  })

  it("validateSetup rejects a stored: ref with no matching token", () => {
    const p = cloudflareManagedTunnelProvider(null)
    expect(() => p.validateSetup!({ zones: CREDS.zones, zoneTokens: '{"examplecom":"x"}' })).toThrow(
      /references stored:exampledev/,
    )
    expect(() => p.validateSetup!(CREDS)).not.toThrow()
  })

  it("start: reconciles, runs cloudflared with the token in env only, reports health", async () => {
    const { cf, sp, provider } = makeProvider({ "wa.example.com": 401 })
    const logs: string[] = []
    const health: TunnelHealth[] = []
    const res = await provider.start({
      target: { host: "127.0.0.1", port: 8081 },
      workspace: "/nonexistent",
      tunnel: { key: "wa", hostnames: ["wa.example.com"] },
      onLog: l => logs.push(l),
      onHealth: h => health.push(h),
    })
    const tunnel = cf.liveTunnels()[0]!
    expect(res).toEqual({ publicUrl: "https://wa.example.com", pid: sp.procs[0]!.pid, tunnelId: tunnel.id })
    expect(tunnel.ingress[0]).toEqual({ hostname: "wa.example.com", service: "http://127.0.0.1:8081" })

    const req = sp.requests[0]!
    expect(req.env).toEqual({ TUNNEL_TOKEN: tunnel.token })
    expect(req.args.join(" ")).not.toContain(tunnel.token)
    expect(req.args).toEqual(["tunnel", "--no-autoupdate", "run"])

    const h = await provider.probeNow()
    expect(h).toMatchObject({ state: "active", hostnames: [{ hostname: "wa.example.com", ok: true }] })
    expect(health.at(-1)?.state).toBe("active")
    expect(logs.join("\n")).not.toContain(tunnel.token)
    await provider.stop()
  })

  it("health: degraded on edge 5xx, degraded while restarting, error on crash loop", async () => {
    const { sp, timers, provider, status } = makeProvider({ "wa.example.com": 530 })
    await provider.start({
      target: { host: "127.0.0.1", port: 8081 },
      workspace: "/nonexistent",
      tunnel: { key: "wa", hostnames: ["wa.example.com"] },
    })
    expect(await provider.probeNow()).toMatchObject({
      state: "degraded",
      reason: "wa.example.com: edge returned 530",
    })
    status["wa.example.com"] = 404
    expect((await provider.probeNow())?.state).toBe("active")

    sp.procs[0]!.exit(1)
    expect(provider.health()).toMatchObject({ state: "degraded", reason: /cloudflared exited.*restarting/ })
    timers.advance(10)
    sp.procs[1]!.exit(1)
    timers.advance(20)
    sp.procs[2]!.exit(1)
    expect(provider.health()).toMatchObject({ state: "error", reason: /crash loop/ })
    await provider.stop()
  })

  it("start fails before any API call on a bad hostname", async () => {
    const { cf, sp, provider } = makeProvider()
    await expect(
      provider.start({
        target: { host: "127.0.0.1", port: 8081 },
        workspace: "/nonexistent",
        tunnel: { key: "wa", hostnames: ["a.b.example.com"] },
      }),
    ).rejects.toThrow(/maxLabels/)
    await expect(
      provider.start({ target: { host: "127.0.0.1", port: 8081 }, workspace: "/nonexistent" }),
    ).rejects.toThrow(/requires a "hostname"/)
    expect(cf.requests).toHaveLength(0)
    expect(sp.procs).toHaveLength(0)
  })

  it("stop keeps the remote tunnel; a restart replays without duplicating", async () => {
    const { cf, provider } = makeProvider()
    const opts = {
      target: { host: "127.0.0.1", port: 8081 },
      workspace: "/nonexistent",
      tunnel: { key: "wa", hostnames: ["wa.example.com"] },
    }
    await provider.start(opts)
    await provider.stop()
    expect(cf.liveTunnels()).toHaveLength(1)
    await provider.start({ ...opts, target: { host: "127.0.0.1", port: 9000 } })
    expect(cf.liveTunnels()).toHaveLength(1)
    expect(cf.records).toHaveLength(1)
    expect(cf.liveTunnels()[0]!.ingress[0]!.service).toBe("http://127.0.0.1:9000")
    await provider.stop()
  })

  it("stop() during start aborts before spawning cloudflared (no leaked runner)", async () => {
    const { sp, provider } = makeProvider()
    const starting = provider.start({
      target: { host: "127.0.0.1", port: 8081 },
      workspace: "/nonexistent",
      tunnel: { key: "wa", hostnames: ["wa.example.com"] },
    })
    // start() is suspended at its first await: runner is still unset, so a
    // stop() here has nothing to kill.
    await provider.stop()
    await expect(starting).rejects.toBeInstanceOf(TunnelStartAbortedError)
    expect(sp.procs).toHaveLength(0)
  })

  it("swap while running: both hostnames probed, then the old one retired", async () => {
    const { cf, provider } = makeProvider({ "wa.example.com": 404, "wa.example.dev": 404 })
    const identity = { key: "wa", hostnames: ["wa.example.com"] }
    await provider.start({ target: { host: "127.0.0.1", port: 8081 }, workspace: "/x", tunnel: identity })
    await provider.addHostname!(identity, "wa.example.dev")
    const h = await provider.probeNow()
    expect(h?.hostnames?.map(x => x.hostname)).toEqual(["wa.example.dev", "wa.example.com"])
    expect(cf.records).toHaveLength(2)

    await provider.removeHostname!({ key: "wa", hostnames: ["wa.example.dev", "wa.example.com"] }, "wa.example.com")
    expect(cf.records.map(r => r.name)).toEqual(["wa.example.dev"])
    expect((await provider.probeNow())?.hostnames?.map(x => x.hostname)).toEqual(["wa.example.dev"])
    await provider.stop()
  })

  it("destroy removes CNAME and tunnel", async () => {
    const { cf, provider } = makeProvider()
    const identity = { key: "wa", hostnames: ["wa.example.com"] }
    await provider.start({ target: { host: "127.0.0.1", port: 8081 }, workspace: "/x", tunnel: identity })
    await provider.stop()
    await provider.destroy!(identity)
    expect(cf.records).toHaveLength(0)
    expect(cf.liveTunnels()).toHaveLength(0)
  })
})
