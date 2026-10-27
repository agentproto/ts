import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { SandboxSpec } from "@agentproto/sandbox"
import { computerSandboxProvider } from "../provider.js"
import { ComputerApiError } from "../client.js"
import { ComputerSandboxError, isCapacityRefusal } from "../errors.js"
import { FakeController } from "./fake-controller.js"

const SERVICE_TOKEN = "svc-secret-capacity-classification-0123456789"

function spec(controllerUrl: string, extra: Record<string, unknown> = {}): SandboxSpec {
  return {
    provider: "computer",
    config: { controllerUrl, token: SERVICE_TOKEN, tenantId: "tenant-a", ...extra },
  }
}

const bootOpts = { env: {} as Record<string, string> }

describe("capacity refusal classification", () => {
  let controller: FakeController

  beforeEach(async () => {
    controller = new FakeController({ token: SERVICE_TOKEN })
    await controller.start()
  })
  afterEach(async () => {
    await controller.stop()
  })

  async function bootError(status: number, code: string, extra: Record<string, unknown> = {}, retryAfter?: string) {
    controller.options.createStatus = status
    controller.options.createError = code
    controller.options.createErrorExtra = extra
    if (retryAfter !== undefined) controller.options.createRetryAfter = retryAfter
    return computerSandboxProvider.boot(spec(controller.url), bootOpts).catch((err: unknown) => err)
  }

  it("maps a 503 fleet-capacity refusal to sandbox_fleet_capacity", async () => {
    const err = await bootError(503, "fleet-capacity", {}, "15")
    expect(err).toBeInstanceOf(ComputerSandboxError)
    expect(err).toMatchObject({ code: "sandbox_fleet_capacity", status: 503, retryAfterMs: 15_000 })
    expect(isCapacityRefusal(err)).toBe(true)
    expect((err as Error).message).not.toContain(SERVICE_TOKEN)
  })

  it("maps the three 429 count caps to their typed codes and keeps cap and Retry-After", async () => {
    const cases = [
      ["tenant-running-cap", "sandbox_tenant_running_cap"],
      ["end-user-cap", "sandbox_end_user_cap"],
      ["fleet-tenant-cap", "sandbox_fleet_tenant_cap"],
    ] as const
    for (const [bodyCode, typedCode] of cases) {
      const err = await bootError(429, bodyCode, { cap: 20 }, "30")
      expect(err).toBeInstanceOf(ComputerSandboxError)
      expect(err).toMatchObject({ code: typedCode, status: 429, cap: 20, retryAfterMs: 30_000 })
      expect(isCapacityRefusal(err)).toBe(true)
      expect((err as Error).message).toContain("cap 20")
      expect((err as Error).message).not.toContain(SERVICE_TOKEN)
      controller.options.createStatus = undefined
      controller.options.createError = undefined
      controller.options.createErrorExtra = undefined
      controller.options.createRetryAfter = undefined
    }
  })

  it("keeps host-capacity as sandbox_capacity and classifies it as a capacity refusal", async () => {
    const err = await bootError(
      503,
      "host-capacity",
      { resource: "memory", requested: 8_192, available: 1_024 },
      "5",
    )
    expect(err).toMatchObject({
      code: "sandbox_capacity",
      status: 503,
      resource: "memory",
      requested: 8_192,
      available: 1_024,
      retryAfterMs: 5_000,
    })
    expect(isCapacityRefusal(err)).toBe(true)
    expect((err as Error).message).not.toContain(SERVICE_TOKEN)
  })

  it("does not call a permanent budget verdict an overflow", async () => {
    controller.options.capacity = {
      memoryMiB: { budget: 4_096, committed: 0, available: 4_096 },
      cpus: { budget: 32, committed: 0, available: 32 },
      computers: 0,
    }
    const err = await bootError(503, "host-capacity", {
      resource: "memory",
      requested: 8_192,
      available: 4_096,
    })
    expect(err).toMatchObject({ code: "sandbox_capacity_exceeds_budget", budget: 4_096 })
    expect(isCapacityRefusal(err)).toBe(false)
  })
})

describe("isCapacityRefusal", () => {
  it("matches the controller body code, never the status alone", () => {
    expect(isCapacityRefusal(new ComputerApiError(503, "host full", "fleet-capacity"))).toBe(true)
    expect(isCapacityRefusal(new ComputerApiError(429, "count cap", "tenant-running-cap"))).toBe(true)
    expect(isCapacityRefusal(new ComputerApiError(429, "count cap", "end-user-cap"))).toBe(true)
    expect(isCapacityRefusal(new ComputerApiError(429, "count cap", "fleet-tenant-cap"))).toBe(true)
    expect(isCapacityRefusal(new ComputerApiError(503, "host full", "host-capacity"))).toBe(true)
    // A 503 whose body is not a capacity refusal (exec untrusted secret).
    expect(isCapacityRefusal(new ComputerApiError(503, "refused", "untrusted-secret"))).toBe(false)
    // Status with no body code, or a non-capacity status.
    expect(isCapacityRefusal(new ComputerApiError(503, "no body"))).toBe(false)
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isCapacityRefusal(new ComputerApiError(status, "rejected", "invalid body"))).toBe(false)
    }
    // Transport failure: no response at all.
    expect(isCapacityRefusal(new ComputerApiError(0, "unreachable"))).toBe(false)
    expect(isCapacityRefusal(new Error("ordinary"))).toBe(false)
    expect(isCapacityRefusal(null)).toBe(false)
  })

  it("is false for permanent verdicts, boot timeouts and non-typed errors", () => {
    expect(isCapacityRefusal(new ComputerSandboxError("sandbox_capacity_exceeds_budget", "never fits"))).toBe(false)
    expect(isCapacityRefusal(new ComputerSandboxError("sandbox_boot_timeout", "timed out"))).toBe(false)
    expect(isCapacityRefusal(new ComputerSandboxError("sandbox_egress_pool_exhausted", "no pool"))).toBe(false)
    expect(isCapacityRefusal(new ComputerSandboxError("sandbox_capacity", "host full"))).toBe(true)
  })

  it("recognises structurally shaped errors from another install", () => {
    expect(isCapacityRefusal({ name: "ComputerSandboxError", code: "sandbox_fleet_capacity" })).toBe(true)
    expect(isCapacityRefusal({ code: "fleet-tenant-cap" })).toBe(true)
    expect(isCapacityRefusal({ code: "sandbox_capacity_exceeds_budget" })).toBe(false)
  })
})
