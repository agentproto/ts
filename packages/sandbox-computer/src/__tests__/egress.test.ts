import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { SandboxSpec } from "@agentproto/sandbox"
import { computerSandboxProvider } from "../provider.js"
import { ComputerSandboxError } from "../errors.js"
import { FakeController } from "./fake-controller.js"

const SERVICE_TOKEN = "svc-secret-egress-0123456789abcdef"

function spec(controllerUrl: string, extra: Record<string, unknown> = {}): SandboxSpec {
  return {
    provider: "computer",
    config: { controllerUrl, token: SERVICE_TOKEN, tenantId: "tenant-a", ...extra },
  }
}

const bootOpts = { env: {} as Record<string, string> }
const EGRESS_IP = { id: "slot-a", publicIp: "203.0.113.10" }

describe("computerSandboxProvider egressIp", () => {
  let controller: FakeController

  beforeEach(async () => {
    controller = new FakeController({ token: SERVICE_TOKEN })
    await controller.start()
  })
  afterEach(async () => {
    await controller.stop()
  })

  it("forwards a non-shared egressIp in the create body and reports it on the booted handle", async () => {
    controller.options.egressIp = EGRESS_IP
    const booted = await computerSandboxProvider.boot(spec(controller.url, { egressIp: "auto" }), bootOpts)

    expect(controller.createBodies[0]).toMatchObject({ egressIp: "auto" })
    expect(booted.egressIp).toEqual(EGRESS_IP)
    await booted.stop()
  })

  it('does not forward the default "shared" value, and surfaces an explicit null from the controller', async () => {
    controller.options.egressIp = null
    const booted = await computerSandboxProvider.boot(spec(controller.url, { egressIp: "shared" }), bootOpts)

    expect(controller.createBodies[0]).not.toHaveProperty("egressIp")
    expect(booted.egressIp).toBeNull()
    await booted.stop()
  })

  it("leaves egressIp out of the create body when no selection is configured", async () => {
    controller.options.egressIp = null
    const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)

    expect(controller.createBodies[0]).not.toHaveProperty("egressIp")
    expect(booted.egressIp).toBeNull()
    await booted.stop()
  })

  it("accepts a spec-level network.egressIp", async () => {
    controller.options.egressIp = EGRESS_IP
    const withNetwork = { ...spec(controller.url), network: { egressIp: "dedicated" } } as SandboxSpec
    const booted = await computerSandboxProvider.boot(withNetwork, bootOpts)

    expect(controller.createBodies[0]).toMatchObject({ egressIp: "dedicated" })
    expect(booted.egressIp).toEqual(EGRESS_IP)
    await booted.stop()
  })

  it("lets config.egressIp win when it matches network.egressIp", async () => {
    controller.options.egressIp = EGRESS_IP
    const both = { ...spec(controller.url, { egressIp: "slot1" }), network: { egressIp: "slot1" } } as SandboxSpec
    const booted = await computerSandboxProvider.boot(both, bootOpts)

    expect(controller.createBodies[0]).toMatchObject({ egressIp: "slot1" })
    await booted.stop()
  })

  it("rejects an invalid config.egressIp before any controller call", async () => {
    await expect(
      computerSandboxProvider.boot(spec(controller.url, { egressIp: "NOT-VALID" }), bootOpts),
    ).rejects.toThrow(/invalid config\.egressIp/)
    expect(controller.createBodies).toEqual([])
    expect(controller.requestHeaders).toEqual([])
  })

  it("rejects an invalid network.egressIp before any controller call", async () => {
    const withNetwork = { ...spec(controller.url), network: { egressIp: "toolongslot" } } as SandboxSpec
    await expect(computerSandboxProvider.boot(withNetwork, bootOpts)).rejects.toThrow(/invalid network\.egressIp/)
    expect(controller.createBodies).toEqual([])
    expect(controller.requestHeaders).toEqual([])
  })

  it("rejects conflicting config and network values before any controller call", async () => {
    const conflict = { ...spec(controller.url, { egressIp: "auto" }), network: { egressIp: "dedicated" } } as SandboxSpec
    await expect(computerSandboxProvider.boot(conflict, bootOpts)).rejects.toThrow(/conflicting egressIp values/)
    expect(controller.createBodies).toEqual([])
    expect(controller.requestHeaders).toEqual([])
  })

  it("reports the controller's egressIp on connect as well as boot", async () => {
    controller.options.egressIp = EGRESS_IP
    const booted = await computerSandboxProvider.boot(spec(controller.url, { egressIp: "auto", maxSessions: 99 }), bootOpts)
    expect(booted.egressIp).toEqual(EGRESS_IP)

    const changed = { id: "slot-b", publicIp: "203.0.113.11" }
    controller.options.egressIp = changed
    const again = await computerSandboxProvider.connect!(
      booted.sandboxId,
      spec(controller.url, { egressIp: "auto", maxSessions: 99 }),
      bootOpts,
    )
    expect(again.egressIp).toEqual(changed)
    await again.stop()
  })

  it.each([
    [400, "egress-pool-disabled", "sandbox_egress_pool_unavailable"],
    [400, "egress-pool-unknown", "sandbox_egress_slot_unknown"],
    [409, "egress-pool-exhausted", "sandbox_egress_pool_exhausted"],
    [409, "egress-slot-dedicated", "sandbox_egress_slot_dedicated"],
  ])("maps HTTP %i %s to %s", async (status, wireCode, expectedCode) => {
    controller.options.createStatus = status
    controller.options.createError = wireCode

    const err = await computerSandboxProvider.boot(spec(controller.url, { egressIp: "auto" }), bootOpts).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(ComputerSandboxError)
    expect(err).toMatchObject({ code: expectedCode, status })
    expect((err as Error).message).not.toContain(SERVICE_TOKEN)
  })

  it("maps host-capacity with its details and Retry-After to sandbox_capacity", async () => {
    controller.options.createStatus = 503
    controller.options.createError = "host-capacity"
    controller.options.createErrorExtra = { resource: "cpu", requested: 4, available: 1 }
    controller.options.createRetryAfter = "12"

    const err = await computerSandboxProvider.boot(spec(controller.url, { egressIp: "auto" }), bootOpts).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(ComputerSandboxError)
    expect(err).toMatchObject({
      code: "sandbox_capacity",
      status: 503,
      resource: "cpu",
      requested: 4,
      available: 1,
      retryAfterMs: 12_000,
    })
    expect((err as Error).message).not.toContain(SERVICE_TOKEN)
  })
})
