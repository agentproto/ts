import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { SandboxSpec } from "@agentproto/sandbox"
import { isSandboxBootCancelledError } from "@agentproto/sandbox"
import { computerSandboxProvider } from "../provider.js"
import { ComputerSandboxError } from "../errors.js"
import { FakeController } from "./fake-controller.js"

const SERVICE_TOKEN = "svc-secret-fleet-capacity-wait-0123456789ab"

function spec(controllerUrl: string, extra: Record<string, unknown> = {}): SandboxSpec {
  return {
    provider: "computer",
    config: { controllerUrl, token: SERVICE_TOKEN, tenantId: "tenant-a", ...extra },
  }
}

// The fleet answers 503 fleet-capacity while it unshelves a host (about
// 10 min 42 s measured on 2026-11-01), then a create lands. Short waits here
// stand in for the real 30 s backoff.
describe("computerSandboxProvider fleet-capacity wait", () => {
  let controller: FakeController

  beforeEach(async () => {
    controller = new FakeController({ token: SERVICE_TOKEN })
    await controller.start()
    controller.options.createStatus = 503
    controller.options.createError = "fleet-capacity"
  })
  afterEach(async () => {
    await controller.stop()
  })

  it("retries a 503 fleet-capacity create until the fleet has room, with one idempotency key", async () => {
    controller.options.createRefusals = 3
    const lines: string[] = []

    const booted = await computerSandboxProvider.boot(spec(controller.url, { fleetCapacityRetryMs: 10 }), {
      env: {},
      log: line => lines.push(line),
    })

    expect(booted.sandboxId).toBe("cmp-001")
    expect(controller.createIdempotencyKeys).toHaveLength(4)
    const [key] = controller.createIdempotencyKeys
    expect(key).toMatch(/^boot-[0-9a-f-]{36}$/)
    expect(new Set(controller.createIdempotencyKeys)).toEqual(new Set([key]))
    expect(controller.createBodies).toHaveLength(1)
    const waits = lines.filter(line => line.includes('"fleet-capacity"') && line.includes("waiting"))
    expect(waits).toHaveLength(3)
    expect(waits[0]).toContain("attempt 1")
    await booted.stop()
  })

  it("honours Retry-After over the default backoff", async () => {
    controller.options.createRefusals = 1
    controller.options.createRetryAfter = "0"
    const lines: string[] = []
    const startedAt = Date.now()

    // A 60 s default backoff would time this test out; Retry-After wins,
    // floored at 1 s so a 0 cannot spin for the whole window.
    const booted = await computerSandboxProvider.boot(spec(controller.url, { fleetCapacityRetryMs: 60_000 }), {
      env: {},
      log: line => lines.push(line),
    })

    expect(Date.now() - startedAt).toBeLessThan(10_000)
    expect(controller.createIdempotencyKeys).toHaveLength(2)
    expect(lines.some(line => line.includes("waiting 1s"))).toBe(true)
    await booted.stop()
  })

  it("clamps a Retry-After longer than the window and makes a last attempt when it closes", async () => {
    controller.options.createRefusals = 1
    controller.options.createRetryAfter = "600"

    const booted = await computerSandboxProvider.boot(spec(controller.url, { fleetCapacityWaitMs: 50 }), { env: {} })

    expect(controller.createIdempotencyKeys).toHaveLength(2)
    await booted.stop()
  })

  it("gives up with sandbox_fleet_capacity once the wait window is spent", async () => {
    const err = await computerSandboxProvider
      .boot(spec(controller.url, { fleetCapacityWaitMs: 200, fleetCapacityRetryMs: 30 }), { env: {} })
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ComputerSandboxError)
    expect(err).toMatchObject({ code: "sandbox_fleet_capacity", status: 503 })
    expect((err as Error).message).toMatch(/still refused after \d+ attempts/)
    expect(controller.createIdempotencyKeys.length).toBeGreaterThan(1)
    expect(controller.createBodies).toHaveLength(0)
  })

  it("fails on the first refusal when the wait is disabled", async () => {
    const err = await computerSandboxProvider
      .boot(spec(controller.url, { fleetCapacityWaitMs: 0 }), { env: {} })
      .catch((e: unknown) => e)

    expect(err).toMatchObject({ code: "sandbox_fleet_capacity" })
    expect(controller.createIdempotencyKeys).toHaveLength(1)
  })

  it("stops waiting when the boot is cancelled", async () => {
    const abort = new AbortController()
    const pending = computerSandboxProvider
      .boot(spec(controller.url, { fleetCapacityRetryMs: 60_000 }), {
        env: {},
        signal: abort.signal,
        log: line => {
          // Abort mid-sleep, not before it, so the timer itself is cancelled.
          if (line.includes("waiting")) setTimeout(() => abort.abort(), 20)
        },
      })
      .catch((e: unknown) => e)

    const err = await pending
    expect(isSandboxBootCancelledError(err)).toBe(true)
    expect(controller.createIdempotencyKeys).toHaveLength(1)
    expect(controller.createBodies).toHaveLength(0)
  })

  it("does not retry a host-capacity refusal", async () => {
    controller.options.createError = "host-capacity"
    controller.options.createRefusals = 1

    const err = await computerSandboxProvider
      .boot(spec(controller.url, { fleetCapacityRetryMs: 10 }), { env: {} })
      .catch((e: unknown) => e)

    expect(err).toMatchObject({ code: "sandbox_capacity" })
    expect(controller.createIdempotencyKeys).toHaveLength(1)
  })
})
