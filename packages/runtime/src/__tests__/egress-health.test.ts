/**
 * The egress IP health ledger: `(publicIp, model, errorClass) -> until`
 * persisted on disk, plus the report/probe that read and refresh it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SandboxExecOpts, SandboxExecResult, SandboxProvider, SandboxSpec } from "@agentproto/sandbox"
import { createEgressHealthLedger, DEFAULT_EGRESS_COOLDOWN_MS, MAX_EGRESS_COOLDOWN_MS } from "../egress-health.js"
import { probeEgressSlots, readEgressHealth } from "../egress-health-report.js"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"

const CI_USAGE_LIMIT =
  "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"
const MODEL = "opencode/big-pickle"
const IP_A = "203.0.113.1"
const IP_B = "203.0.113.2"

let dir: string
let path: string
let clock: number
const now = () => clock

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentproto-egress-health-"))
  path = join(dir, "egress-health.json")
  clock = Date.parse("2026-01-01T00:00:00Z")
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

describe("egress health ledger", () => {
  it("marks an address for a model and reports it cooling until the deadline", () => {
    const ledger = createEgressHealthLedger({ path, now })
    const entry = ledger.mark({ publicIp: IP_A, model: MODEL, errorClass: "usage-limit", slot: "a", source: "s1" })
    expect(entry).toMatchObject({ publicIp: IP_A, model: MODEL, errorClass: "usage-limit", slot: "a", source: "s1" })
    expect(entry.remainingMs).toBe(DEFAULT_EGRESS_COOLDOWN_MS["usage-limit"])
    expect(ledger.cooling(IP_A, MODEL)).toEqual({ until: clock + DEFAULT_EGRESS_COOLDOWN_MS["usage-limit"], errorClass: "usage-limit" })
    // keyed by model and by address
    expect(ledger.cooling(IP_A, "opencode/other")).toBeUndefined()
    expect(ledger.cooling(IP_B, MODEL)).toBeUndefined()
  })

  it("expires: a cooldown past its deadline is gone from every read", () => {
    const ledger = createEgressHealthLedger({ path, now })
    ledger.mark({ publicIp: IP_A, model: MODEL, errorClass: "rate-limit" })
    clock += DEFAULT_EGRESS_COOLDOWN_MS["rate-limit"] - 1
    expect(ledger.cooling(IP_A, MODEL)).toBeDefined()
    clock += 1
    expect(ledger.cooling(IP_A, MODEL)).toBeUndefined()
    expect(ledger.list()).toEqual([])
    expect(ledger.view(MODEL).cooling(IP_A)).toBeUndefined()
  })

  it("persists across instances, so the CLI and the daemon share one truth", async () => {
    createEgressHealthLedger({ path, now }).mark({ publicIp: IP_A, model: MODEL, errorClass: "usage-limit" })
    const other = createEgressHealthLedger({ path, now })
    expect(other.cooling(IP_A, MODEL)?.errorClass).toBe("usage-limit")
    expect(JSON.parse(await readFile(path, "utf8")).cooldowns).toHaveLength(1)
  })

  it("never shortens an active cooldown and clamps an absurd hint", () => {
    const ledger = createEgressHealthLedger({ path, now })
    const long = ledger.mark({ publicIp: IP_A, model: MODEL, errorClass: "rate-limit", durationMs: 30 * 60_000 })
    const short = ledger.mark({ publicIp: IP_A, model: MODEL, errorClass: "rate-limit", durationMs: 1_000 })
    expect(short.until).toBe(long.until)
    expect(ledger.list()).toHaveLength(1)
    const clamped = ledger.mark({ publicIp: IP_B, model: MODEL, errorClass: "rate-limit", durationMs: 99 * 3_600_000 })
    expect(clamped.remainingMs).toBe(MAX_EGRESS_COOLDOWN_MS)
  })

  it("reports the longest cooldown across classes and lists soonest-to-expire first", () => {
    const ledger = createEgressHealthLedger({ path, now })
    ledger.mark({ publicIp: IP_A, model: MODEL, errorClass: "usage-limit" })
    ledger.mark({ publicIp: IP_A, model: MODEL, errorClass: "rate-limit" })
    ledger.mark({ publicIp: IP_B, model: "opencode/other", errorClass: "rate-limit" })
    expect(ledger.cooling(IP_A, MODEL)?.errorClass).toBe("usage-limit")
    expect(ledger.list().map(e => e.errorClass)).toEqual(["rate-limit", "rate-limit", "usage-limit"])
    expect(ledger.list({ model: MODEL })).toHaveLength(2)
  })

  it("clear drops one class or all, and reports how many", () => {
    const ledger = createEgressHealthLedger({ path, now })
    ledger.mark({ publicIp: IP_A, model: MODEL, errorClass: "usage-limit" })
    ledger.mark({ publicIp: IP_A, model: MODEL, errorClass: "rate-limit" })
    expect(ledger.clear({ publicIp: IP_A, model: MODEL, errorClass: "rate-limit" })).toBe(1)
    expect(ledger.cooling(IP_A, MODEL)?.errorClass).toBe("usage-limit")
    expect(ledger.clear({ publicIp: IP_A, model: MODEL })).toBe(1)
    expect(ledger.clear({ publicIp: IP_A, model: MODEL })).toBe(0)
    expect(ledger.cooling(IP_A, MODEL)).toBeUndefined()
  })

  it("treats a corrupt or missing file as empty and recovers on the next write", async () => {
    const ledger = createEgressHealthLedger({ path, now })
    expect(ledger.list()).toEqual([])
    await writeFile(path, "{not json", "utf8")
    expect(ledger.list()).toEqual([])
    ledger.mark({ publicIp: IP_A, model: MODEL, errorClass: "usage-limit" })
    expect(ledger.list()).toHaveLength(1)
  })

  it("honours AGENTPROTO_EGRESS_HEALTH for the default path", async () => {
    const prev = process.env.AGENTPROTO_EGRESS_HEALTH
    process.env.AGENTPROTO_EGRESS_HEALTH = path
    try {
      createEgressHealthLedger({ now }).mark({ publicIp: IP_A, model: MODEL, errorClass: "usage-limit" })
      expect(JSON.parse(await readFile(path, "utf8")).cooldowns[0].publicIp).toBe(IP_A)
    } finally {
      if (prev === undefined) delete process.env.AGENTPROTO_EGRESS_HEALTH
      else process.env.AGENTPROTO_EGRESS_HEALTH = prev
    }
  })
})

describe("readEgressHealth / probeEgressSlots", () => {
  const POOL = [
    { id: "a", publicIp: IP_A, computers: 1 },
    { id: "b", publicIp: IP_B, computers: 0 },
  ]
  let stops: string[]
  let bootSpecs: SandboxSpec[]
  let execBySlot: Record<string, (o: SandboxExecOpts) => Promise<SandboxExecResult>>
  const out = (over: Partial<SandboxExecResult> = {}): SandboxExecResult => ({
    exitCode: 0,
    stdout: "ok\n",
    stderr: "",
    durationMs: 1,
    ...over,
  })

  const handle = (): SandboxProviderHandle => {
    const provider: SandboxProvider = {
      egressPool: vi.fn(async () => POOL),
      boot: vi.fn(async spec => {
        bootSpecs.push(spec)
        const slot = String((spec.config as { egressIp?: string }).egressIp)
        const pool = POOL.find(p => p.id === slot)!
        return {
          mcpUrl: "http://127.0.0.1:1/mcp",
          sandboxId: `sbx_${slot}`,
          egressIp: { id: slot, publicIp: pool.publicIp },
          stop: async () => {
            stops.push(slot)
          },
          exec: (o: SandboxExecOpts) => execBySlot[slot]!(o),
        }
      }),
    } as unknown as SandboxProvider
    return {
      provider,
      slug: "computer",
      name: "Computer",
      version: "test",
      description: "test",
      requiresSetup: false,
      capabilities: { networkEgress: false, mounts: false, lifecyclePause: false, readOnly: false },
      defaultCwd: "/home/user",
      async check() {
        return true
      },
    }
  }
  const deps = (ledger = createEgressHealthLedger({ path, now })) => ({
    ledger,
    resolveSandboxProvider: async (slug: string) => (slug === "computer" ? handle() : null),
  })

  beforeEach(() => {
    stops = []
    bootSpecs = []
    execBySlot = { a: async () => out(), b: async () => out() }
  })

  it("lists slots and addresses with the active cooldowns folded in", async () => {
    const d = deps()
    d.ledger.mark({ publicIp: IP_B, model: MODEL, errorClass: "usage-limit", slot: "b" })
    const report = await readEgressHealth({}, d)
    expect(report.ok).toBe(true)
    if (!report.ok) return
    expect(report.slots.map(s => [s.slot, s.publicIp, s.cooling.length])).toEqual([
      ["a", IP_A, 0],
      ["b", IP_B, 1],
    ])
    expect(report.cooldowns).toHaveLength(1)
    const narrowed = await readEgressHealth({ model: "opencode/other" }, d)
    expect(narrowed.ok && narrowed.cooldowns).toEqual([])
  })

  it("fails typed for an unknown provider and one without a pool", async () => {
    const missing = await readEgressHealth({ provider: "nope" }, deps())
    expect(missing).toMatchObject({ ok: false, code: "egress_provider_not_found" })
    const noPool = await readEgressHealth(
      { provider: "computer" },
      {
        ledger: createEgressHealthLedger({ path, now }),
        resolveSandboxProvider: async () => ({ ...handle(), provider: { boot: vi.fn() } as unknown as SandboxProvider }),
      },
    )
    expect(noPool).toMatchObject({ ok: false, code: "egress_pool_unsupported" })
  })

  it("probe: a usage-cap ko sets the cooldown, an ok clears it, and every box is stopped", async () => {
    const d = deps()
    d.ledger.mark({ publicIp: IP_B, model: MODEL, errorClass: "usage-limit" })
    execBySlot.a = async () => out({ exitCode: 1, stdout: "", stderr: CI_USAGE_LIMIT })
    const report = await probeEgressSlots({ model: MODEL }, d)
    expect(report.ok).toBe(true)
    if (!report.ok) return
    expect(report.results.map(r => [r.slot, r.verdict])).toEqual([
      ["a", "ko"],
      ["b", "ok"],
    ])
    expect(d.ledger.cooling(IP_A, MODEL)?.errorClass).toBe("usage-limit")
    expect(d.ledger.cooling(IP_B, MODEL)).toBeUndefined()
    expect(stops.sort()).toEqual(["a", "b"])
  })

  it("probe: every slot's box boots in parallel", async () => {
    let releaseBoth: (() => void) | undefined
    const bothStarted = new Promise<void>(resolve => {
      releaseBoth = resolve
    })
    let started = 0
    const base = handle()
    ;(base.provider.boot as ReturnType<typeof vi.fn>).mockImplementation(async (spec: SandboxSpec) => {
      started++
      if (started === 2) releaseBoth?.()
      await bothStarted
      const slot = String((spec.config as { egressIp?: string }).egressIp)
      const pool = POOL.find(p => p.id === slot)!
      return {
        mcpUrl: "http://127.0.0.1:1/mcp",
        sandboxId: `sbx_${slot}`,
        egressIp: { id: slot, publicIp: pool.publicIp },
        stop: async () => {
          stops.push(slot)
        },
        exec: (o: SandboxExecOpts) => execBySlot[slot]!(o),
      }
    })
    const d = {
      ledger: createEgressHealthLedger({ path, now }),
      resolveSandboxProvider: async (slug: string) => (slug === "computer" ? base : null),
    }
    const report = await Promise.race([
      probeEgressSlots({ model: MODEL }, d),
      new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 250)),
    ])
    expect(report).not.toBe("timeout")
    if (report === "timeout" || !report.ok) return
    expect(started).toBe(2)
    expect(report.results.map(r => r.verdict)).toEqual(["ok", "ok"])
  })

  it("probe: boots each box at 1 GiB with the egress hosts opencode needs", async () => {
    const report = await probeEgressSlots({ model: MODEL }, deps())
    expect(report.ok).toBe(true)
    if (!report.ok) return
    expect(bootSpecs).toHaveLength(2)
    for (const spec of bootSpecs) {
      expect(spec.config).toMatchObject({
        cpus: 1,
        memoryMiB: 1024,
        egress: ["opencode.ai", "models.opencode.ai", "models.dev", "rdv.agentproto.sh", "registry.npmjs.org"],
      })
    }
  })

  it("probe: an inconclusive probe or a boot error changes nothing", async () => {
    const d = deps()
    d.ledger.mark({ publicIp: IP_A, model: MODEL, errorClass: "rate-limit" })
    execBySlot.a = async () => out({ exitCode: 127, stdout: "", stderr: "opencode: command not found" })
    execBySlot.b = async () => {
      throw new Error("exec exploded")
    }
    const report = await probeEgressSlots({ model: MODEL }, d)
    expect(report.ok).toBe(true)
    if (!report.ok) return
    expect(report.results.map(r => r.verdict)).toEqual(["unknown", "unknown"])
    expect(d.ledger.cooling(IP_A, MODEL)?.errorClass).toBe("rate-limit")
    expect(stops.sort()).toEqual(["a", "b"])
  })
})
