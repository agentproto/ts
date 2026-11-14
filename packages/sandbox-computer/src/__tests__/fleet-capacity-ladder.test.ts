import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SandboxSpec } from "@agentproto/sandbox"
import { computerSandboxProvider } from "../provider.js"
import { ComputerSandboxError } from "../errors.js"

const SERVICE_TOKEN = "svc-secret-fleet-capacity-ladder-0123456789"
const MINUTE = 60_000

function spec(extra: Record<string, unknown> = {}): SandboxSpec {
  return {
    provider: "computer",
    config: { controllerUrl: "http://fleet.invalid", token: SERVICE_TOKEN, tenantId: "tenant-a", ...extra },
  }
}

// A full fleet answers 503 fleet-capacity to every create; `retryAfter` is the
// header the fleet sends while a host is waking (absent when none is). Fake
// timers and a stubbed global fetch: nothing here touches the network.
describe("computerSandboxProvider fleet-capacity wait inside a placement ladder", () => {
  let creates: number
  let retryAfter: string | undefined
  let reason: string | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    creates = 0
    retryAfter = undefined
    reason = "no-active-host"
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        creates++
        return new Response(JSON.stringify({ error: "fleet-capacity", ...(reason ? { reason } : {}) }), {
          status: 503,
          headers: { "content-type": "application/json", ...(retryAfter !== undefined ? { "retry-after": retryAfter } : {}) },
        })
      }),
    )
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const settle = (promise: Promise<unknown>): { state: () => "pending" | "rejected" | "resolved"; error: () => unknown } => {
    let state: "pending" | "rejected" | "resolved" = "pending"
    let error: unknown
    promise.then(
      () => (state = "resolved"),
      e => {
        state = "rejected"
        error = e
      },
    )
    return { state: () => state, error: () => error }
  }

  it("fails the rung at once when the refusal has no Retry-After, keeping the reason", async () => {
    const lines: string[] = []
    const outcome = settle(
      computerSandboxProvider.boot(spec(), { env: {}, capacityWaitBudgetMs: 5 * MINUTE, log: line => lines.push(line) }),
    )

    await vi.advanceTimersByTimeAsync(0)

    expect(outcome.state()).toBe("rejected")
    expect(creates).toBe(1)
    const err = outcome.error()
    expect(err).toBeInstanceOf(ComputerSandboxError)
    expect(err).toMatchObject({ code: "sandbox_fleet_capacity", status: 503 })
    expect((err as Error).message).toContain("no-active-host")
    expect((err as Error).message).toContain("another placement is available")
    expect(lines.some(line => line.includes("no Retry-After") && line.includes("next placement"))).toBe(true)
  })

  it("waits once for Retry-After, then fails the rung on a second refusal", async () => {
    retryAfter = "20"
    const outcome = settle(computerSandboxProvider.boot(spec(), { env: {}, capacityWaitBudgetMs: 5 * MINUTE }))

    await vi.advanceTimersByTimeAsync(19_000)
    expect(outcome.state()).toBe("pending")
    expect(creates).toBe(1)

    await vi.advanceTimersByTimeAsync(1_500)
    expect(outcome.state()).toBe("rejected")
    expect(creates).toBe(2)
    expect(outcome.error()).toMatchObject({ code: "sandbox_fleet_capacity" })
  })

  it("caps the one wait at the rung's budget", async () => {
    retryAfter = "600"
    const outcome = settle(computerSandboxProvider.boot(spec(), { env: {}, capacityWaitBudgetMs: 45_000 }))

    await vi.advanceTimersByTimeAsync(44_000)
    expect(outcome.state()).toBe("pending")
    expect(creates).toBe(1)

    await vi.advanceTimersByTimeAsync(1_500)
    expect(outcome.state()).toBe("rejected")
    expect(creates).toBe(2)
  })

  it("keeps the 12 minute wait for a boot with no ladder budget", async () => {
    const outcome = settle(computerSandboxProvider.boot(spec(), { env: {} }))

    await vi.advanceTimersByTimeAsync(11 * MINUTE)
    expect(outcome.state()).toBe("pending")
    expect(creates).toBeGreaterThan(10)

    await vi.advanceTimersByTimeAsync(2 * MINUTE)
    expect(outcome.state()).toBe("rejected")
    expect(outcome.error()).toMatchObject({ code: "sandbox_fleet_capacity" })
    expect((outcome.error() as Error).message).toMatch(/still refused after \d+ attempts/)
  })
})
