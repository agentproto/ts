import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  isSandboxEgressAllCoolingError,
  type SandboxEgressHealthView,
  type SandboxSpec,
} from "@agentproto/sandbox"
import { computerSandboxProvider, pickEgressSlot } from "../provider.js"
import { FakeController } from "./fake-controller.js"

const SERVICE_TOKEN = "svc-secret-slots-0123456789abcdef"
const NOW = Date.parse("2026-01-01T00:00:00Z")

const POOL = [
  { id: "a", sourceIp: "10.0.0.1", publicIp: "203.0.113.1", computers: 2 },
  { id: "b", sourceIp: "10.0.0.2", publicIp: "203.0.113.2", computers: 0 },
  { id: "c", sourceIp: "10.0.0.3", publicIp: "203.0.113.3", computers: 1 },
]

function spec(controllerUrl: string, extra: Record<string, unknown> = {}): SandboxSpec {
  return {
    provider: "computer",
    config: { controllerUrl, token: SERVICE_TOKEN, tenantId: "tenant-a", egressIp: "auto", ...extra },
  }
}

function view(cooling: Record<string, string>, model = "opencode/big-pickle"): SandboxEgressHealthView {
  return {
    model,
    cooling: ip => (cooling[ip] ? { until: NOW + 3_600_000, errorClass: cooling[ip] } : undefined),
  }
}

describe("pickEgressSlot", () => {
  it("orders healthy slots least loaded first and reports the cooling ones", () => {
    const picked = pickEgressSlot(POOL, view({ "203.0.113.2": "usage-limit" }))
    expect(picked.candidates).toEqual(["c", "a"])
    expect(picked.cooling).toEqual([
      { slot: "b", publicIp: "203.0.113.2", until: new Date(NOW + 3_600_000).toISOString(), errorClass: "usage-limit" },
    ])
  })

  it("returns no candidates when every slot is cooling", () => {
    const all = { "203.0.113.1": "usage-limit", "203.0.113.2": "rate-limit", "203.0.113.3": "usage-limit" }
    expect(pickEgressSlot(POOL, view(all)).candidates).toEqual([])
  })
})

describe("computerSandboxProvider egressIp auto with an egress health view", () => {
  let controller: FakeController

  beforeEach(async () => {
    controller = new FakeController({ token: SERVICE_TOKEN })
    await controller.start()
    controller.options.egressPool = POOL
  })
  afterEach(async () => {
    await controller.stop()
  })

  it("names an explicit healthy slot instead of sending auto", async () => {
    const booted = await computerSandboxProvider.boot(spec(controller.url), {
      env: {},
      egressHealth: view({ "203.0.113.2": "usage-limit" }),
    })
    expect(controller.createBodies[0]).toMatchObject({ egressIp: "c" })
    expect(booted.egressIp).toEqual({ id: "c", publicIp: "203.0.113.3" })
    await booted.stop()
  })

  it("keeps sending auto when no health view is given", async () => {
    const booted = await computerSandboxProvider.boot(spec(controller.url), { env: {} })
    expect(controller.createBodies[0]).toMatchObject({ egressIp: "auto" })
    await booted.stop()
  })

  it("throws the typed all-cooling error and creates nothing when every slot is cooling", async () => {
    const all = { "203.0.113.1": "usage-limit", "203.0.113.2": "rate-limit", "203.0.113.3": "usage-limit" }
    const err = await computerSandboxProvider
      .boot(spec(controller.url), { env: {}, egressHealth: view(all) })
      .catch((e: unknown) => e)
    expect(isSandboxEgressAllCoolingError(err)).toBe(true)
    expect((err as { model: string; slots: unknown[] }).model).toBe("opencode/big-pickle")
    expect((err as { slots: unknown[] }).slots).toHaveLength(3)
    expect(controller.createBodies).toEqual([])
  })

  it("moves on to the next healthy slot when the controller refuses one as dedicated", async () => {
    controller.options.dedicatedSlots = ["b"]
    const booted = await computerSandboxProvider.boot(spec(controller.url), { env: {}, egressHealth: view({}) })
    expect(controller.createBodies.map(b => b.egressIp)).toEqual(["c"])
    await booted.stop()

    controller.options.dedicatedSlots = ["c"]
    const second = await computerSandboxProvider.boot(spec(controller.url), { env: {}, egressHealth: view({}) })
    expect(second.egressIp).toEqual({ id: "b", publicIp: "203.0.113.2" })
    await second.stop()
  })

  it("falls back to the controller's own auto when the pool is not readable", async () => {
    controller.options.egressPool = undefined
    const booted = await computerSandboxProvider.boot(spec(controller.url), { env: {}, egressHealth: view({}) })
    expect(controller.createBodies[0]).toMatchObject({ egressIp: "auto" })
    await booted.stop()
  })

  it("does not consult the pool for an explicit slot", async () => {
    const booted = await computerSandboxProvider.boot(spec(controller.url, { egressIp: "a" }), {
      env: {},
      egressHealth: view({ "203.0.113.1": "usage-limit" }),
    })
    expect(controller.createBodies[0]).toMatchObject({ egressIp: "a" })
    await booted.stop()
  })

  it("lists the pool through the provider", async () => {
    const slots = await computerSandboxProvider.egressPool?.(spec(controller.url))
    expect(slots).toEqual([
      { id: "a", publicIp: "203.0.113.1", computers: 2 },
      { id: "b", publicIp: "203.0.113.2", computers: 0 },
      { id: "c", publicIp: "203.0.113.3", computers: 1 },
    ])
  })
})

// On 2026-11-04 host A (a1..a6) was full and host B (b1..b6) was free. The
// client named a2, the fleet treated it as a host pin and refused for
// capacity, and the boot slept the whole fleet-capacity window on a2.
describe("computerSandboxProvider egressIp auto when a slot's host is full", () => {
  let controller: FakeController

  const hosted = (id: string, hostId: string | undefined, n: number) => ({
    id,
    sourceIp: `10.0.0.${n}`,
    publicIp: `203.0.113.${n}`,
    computers: 0,
    ...(hostId !== undefined ? { hostId } : {}),
  })
  const POOL_AB = [
    hosted("a1", "host-a", 1),
    hosted("a2", "host-a", 2),
    hosted("a3", "host-a", 3),
    hosted("b1", "host-b", 11),
    hosted("b2", "host-b", 12),
  ]
  const FULL_A = { a1: "memory", a2: "memory", a3: "memory" }

  beforeEach(async () => {
    controller = new FakeController({ token: SERVICE_TOKEN })
    await controller.start()
    controller.options.egressPool = POOL_AB
  })
  afterEach(async () => {
    await controller.stop()
  })

  it("moves to a slot on another host instead of waiting on the full one", async () => {
    controller.options.capacityRefusedSlots = FULL_A
    const lines: string[] = []
    const startedAt = Date.now()

    const booted = await computerSandboxProvider.boot(spec(controller.url, { fleetCapacityRetryMs: 60_000 }), {
      env: {},
      egressHealth: view({}),
      log: line => lines.push(line),
    })

    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(controller.createEgressAttempts).toEqual(["a1", "b1"])
    expect(booted.egressIp).toEqual({ id: "b1", publicIp: "203.0.113.11" })
    expect(lines.filter(line => line.includes("waiting"))).toEqual([])
    expect(lines.some(line => line.includes("egress slot a1 refused") && line.includes("memory") && line.includes("b1"))).toBe(true)
    expect(lines.some(line => line.includes("skipping a2, a3 on a host already refused (host-a)"))).toBe(true)
    await booted.stop()
  })

  it("treats the legacy egress-slot-unavailable reason the same way", async () => {
    controller.options.capacityRefusedSlots = { a1: "egress-slot-unavailable" }
    const booted = await computerSandboxProvider.boot(spec(controller.url, { fleetCapacityRetryMs: 60_000 }), {
      env: {},
      egressHealth: view({}),
    })
    expect(controller.createEgressAttempts).toEqual(["a1", "b1"])
    await booted.stop()
  })

  it("sends plain auto once every slot was refused for capacity", async () => {
    controller.options.capacityRefusedSlots = { ...FULL_A, b1: "memory", b2: "memory" }
    const lines: string[] = []

    const booted = await computerSandboxProvider.boot(spec(controller.url, { fleetCapacityRetryMs: 60_000 }), {
      env: {},
      egressHealth: view({}),
      log: line => lines.push(line),
    })

    expect(controller.createEgressAttempts).toEqual(["a1", "b1", "auto"])
    expect(controller.createBodies).toHaveLength(1)
    expect(controller.createBodies[0]).toMatchObject({ egressIp: "auto" })
    expect(lines.some(line => line.includes("sending auto"))).toBe(true)
    expect(lines.filter(line => line.includes("waiting"))).toEqual([])
    await booted.stop()
  })

  it("advances to the next slot when the pool does not say which host owns a slot", async () => {
    controller.options.egressPool = POOL_AB.map(({ hostId: _hostId, ...slot }) => slot)
    controller.options.capacityRefusedSlots = FULL_A
    const booted = await computerSandboxProvider.boot(spec(controller.url, { fleetCapacityRetryMs: 60_000 }), {
      env: {},
      egressHealth: view({}),
    })
    expect(controller.createEgressAttempts).toEqual(["a1", "a2", "a3", "b1"])
    await booted.stop()
  })

  it("waits for the fleet once auto is refused too", async () => {
    controller.options.capacityRefusedSlots = { ...FULL_A, b1: "memory", b2: "memory", auto: "memory" }
    const err = await computerSandboxProvider
      .boot(spec(controller.url, { fleetCapacityWaitMs: 100, fleetCapacityRetryMs: 20 }), {
        env: {},
        egressHealth: view({}),
      })
      .catch((e: unknown) => e)

    expect(err).toMatchObject({ code: "sandbox_fleet_capacity" })
    expect(controller.createEgressAttempts.slice(0, 3)).toEqual(["a1", "b1", "auto"])
    expect(new Set(controller.createEgressAttempts.slice(2))).toEqual(new Set(["auto"]))
    expect(controller.createEgressAttempts.length).toBeGreaterThan(3)
  })

  it("does not skip slots for a refusal that no other host can relieve", async () => {
    controller.options.capacityRefusedSlots = { a1: "no-active-host" }
    const err = await computerSandboxProvider
      .boot(spec(controller.url, { fleetCapacityWaitMs: 100, fleetCapacityRetryMs: 20 }), {
        env: {},
        egressHealth: view({}),
      })
      .catch((e: unknown) => e)

    expect(err).toMatchObject({ code: "sandbox_fleet_capacity" })
    expect(new Set(controller.createEgressAttempts)).toEqual(new Set(["a1"]))
  })
})
