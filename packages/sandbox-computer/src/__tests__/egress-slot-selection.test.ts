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
