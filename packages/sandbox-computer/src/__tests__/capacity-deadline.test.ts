import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SandboxSpec } from "@agentproto/sandbox"
import { computerSandboxProvider } from "../provider.js"
import { ComputerSandboxError } from "../errors.js"
import { FakeController } from "./fake-controller.js"

const SERVICE_TOKEN = "svc-secret-capacity-deadline-0123456789abcdef"

function spec(controllerUrl: string, extra: Record<string, unknown> = {}): SandboxSpec {
  return {
    provider: "computer",
    config: { controllerUrl, token: SERVICE_TOKEN, tenantId: "tenant-a", ...extra },
  }
}

const bootOpts = { env: {} as Record<string, string> }

describe("computerSandboxProvider capacity budget", () => {
  let controller: FakeController

  beforeEach(async () => {
    controller = new FakeController({ token: SERVICE_TOKEN })
    await controller.start()
  })
  afterEach(async () => {
    await controller.stop()
  })

  it("fails as 'can never fit' when the request exceeds the tenant TOTAL budget", async () => {
    // The incident: 16 GiB asked for on a tenant whose WHOLE budget was
    // 13567 MiB, with 13567 MiB reported free.
    controller.options.createStatus = 503
    controller.options.createError = "host-capacity"
    controller.options.createErrorExtra = { resource: "memory", requested: 16_384, available: 13_567 }
    controller.options.createRetryAfter = "30"
    controller.options.capacity = {
      memoryMiB: { budget: 13_567, committed: 0, available: 13_567 },
      cpus: { budget: 32, committed: 0, available: 32 },
      computers: 0,
    }

    const err = await computerSandboxProvider
      .boot(spec(controller.url, { memoryMiB: 16_384 }), bootOpts)
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ComputerSandboxError)
    expect(err).toMatchObject({
      code: "sandbox_capacity_exceeds_budget",
      resource: "memory",
      requested: 16_384,
      budget: 13_567,
    })
    expect((err as Error).message).toContain(
      "requested 16384 MiB exceeds the tenant budget 13567 MiB; this can never fit",
    )
    expect((err as Error).message).not.toContain("retry after")
    expect((err as ComputerSandboxError).retryAfterMs).toBeUndefined()
  })

  it("keeps the retry hint when the request fits the TOTAL budget but not the free space", async () => {    controller.options.createStatus = 503
    controller.options.createError = "host-capacity"
    controller.options.createErrorExtra = { resource: "memory", requested: 8_192, available: 1_028 }
    controller.options.createRetryAfter = "30"
    controller.options.capacity = {
      memoryMiB: { budget: 13_567, committed: 12_539, available: 1_028 },
      cpus: { budget: 32, committed: 2, available: 30 },
      computers: 1,
    }

    const err = await computerSandboxProvider
      .boot(spec(controller.url, { memoryMiB: 8_192 }), bootOpts)
      .catch((e: unknown) => e)

    expect(err).toMatchObject({ code: "sandbox_capacity", retryAfterMs: 30_000 })
    expect((err as Error).message).toContain("retry after 30s")
    expect((err as Error).message).not.toContain("can never fit")
  })

  it("logs one daemon line per boot phase through the injected logger", async () => {
    const lines: string[] = []
    const booted = await computerSandboxProvider.boot(spec(controller.url), {
      env: {},
      log: line => lines.push(line),
    })

    expect(lines.some(line => line.includes("create requested"))).toBe(true)
    expect(lines.some(line => line.includes(`computer ${booted.sandboxId} running`))).toBe(true)
    expect(lines.some(line => line.includes(`computer ${booted.sandboxId} daemon healthy`))).toBe(true)
    await booted.stop()
  })
})

describe("computerSandboxProvider boot deadline", () => {
  let controller: FakeController

  beforeEach(async () => {
    controller = new FakeController({ token: SERVICE_TOKEN })
    await controller.start()
  })
  afterEach(async () => {
    vi.useRealTimers()
    await controller.stop()
  })

  it("fails at the deadline naming the stuck phase when the box never reaches running", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
    controller.setNextCreateState("starting")

    const bootPromise = computerSandboxProvider
      .boot(spec(controller.url, { bootDeadlineMs: 5_000 }), bootOpts)
      .then(
        value => value,
        (err: unknown) => err,
      )

    // Let create settle (real socket I/O is not timer-driven) and the first
    // polling GET start.
    for (let i = 0; i < 200 && controller.states.size === 0; i++) {
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(controller.states.size).toBe(1)
    await vi.advanceTimersByTimeAsync(6_000)

    const err = await bootPromise
    expect(err).toBeInstanceOf(ComputerSandboxError)
    expect(err).toMatchObject({
      code: "sandbox_boot_timeout",
      phase: "running",
    })
    expect((err as Error).message).toMatch(/did not reach running within \d+ms/)
    // The failed boot reclaimed the computer it created.
    expect(controller.removed).toHaveLength(1)
  })
})
