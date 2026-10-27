import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { E2B_PRICING_OVERRIDE } from "./fixtures/e2b-pricing.js"

const { sandboxListMock } = vi.hoisted(() => ({ sandboxListMock: vi.fn() }))

vi.mock("e2b", () => ({
  Sandbox: { list: sandboxListMock },
  CommandExitError: class CommandExitError extends Error {},
  SandboxNotFoundError: class SandboxNotFoundError extends Error {},
}))

function paginator(pages: unknown[][]): {
  hasNext: boolean
  nextItems: () => Promise<unknown[]>
} {
  let index = 0
  const state = {
    get hasNext() {
      return index < pages.length
    },
    nextItems: async () => pages[index++] ?? [],
  }
  return state
}

function info(overrides: Record<string, unknown> = {}) {
  return {
    sandboxId: "sbx_1",
    templateId: "tpl",
    metadata: {},
    startedAt: new Date("2026-10-20T00:00:00.000Z"),
    endAt: new Date("2026-10-27T00:00:00.000Z"),
    state: "running",
    cpuCount: 2,
    memoryMB: 1024,
    envdVersion: "0.1",
    ...overrides,
  }
}

describe("e2bSandboxProvider.list", () => {
  beforeEach(() => {
    sandboxListMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it("does not touch the SDK until list or usage is called", async () => {
    await import("../provider.js")
    expect(sandboxListMock).not.toHaveBeenCalled()
  })

  it("maps both pages and keeps paused boxes (they still bill)", async () => {
    sandboxListMock.mockReturnValue(
      paginator([
        [info({ sandboxId: "sbx_a", state: "running" })],
        [info({ sandboxId: "sbx_b", state: "paused", cpuCount: 4, memoryMB: 2048 })],
      ]),
    )

    const { e2bSandboxProvider } = await import("../provider.js")
    const boxes = await e2bSandboxProvider.list!()

    expect(boxes).toEqual([
      {
        id: "sbx_a",
        provider: "e2b",
        state: "running",
        cpus: 2,
        memoryMiB: 1024,
        createdAt: "2026-10-20T00:00:00.000Z",
      },
      {
        id: "sbx_b",
        provider: "e2b",
        state: "paused",
        cpus: 4,
        memoryMiB: 2048,
        createdAt: "2026-10-20T00:00:00.000Z",
      },
    ])
  })

  it("follows every page of the paginator", async () => {
    sandboxListMock.mockReturnValue(
      paginator([
        [info({ sandboxId: "sbx_a" })],
        [info({ sandboxId: "sbx_b" })],
        [info({ sandboxId: "sbx_c" })],
      ]),
    )

    const { e2bSandboxProvider } = await import("../provider.js")
    const boxes = await e2bSandboxProvider.list!()

    expect(boxes.map((box) => box.id)).toEqual(["sbx_a", "sbx_b", "sbx_c"])
  })
})

describe("e2bSandboxProvider.usage", () => {
  beforeEach(() => {
    sandboxListMock.mockReset()
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-27T00:00:00.000Z"))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it("clamps the active interval to the requested window and derives vcpu/gib seconds", async () => {
    sandboxListMock.mockReturnValue(paginator([[info()]]))

    const { e2bSandboxProvider } = await import("../provider.js")
    const windows = await e2bSandboxProvider.usage!({
      from: "2026-10-20T06:00:00.000Z",
      to: "2026-10-20T12:00:00.000Z",
    })

    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({
      computer: "sbx_1",
      tenantId: "unknown",
      provider: "e2b",
      from: "2026-10-20T06:00:00.000Z",
      to: "2026-10-20T12:00:00.000Z",
      activeSec: 6 * 3600,
      vcpuSec: 6 * 3600 * 2,
      gibSec: (6 * 3600 * 1024) / 1024,
    })
  })

  it("clamps the end at endAt and at now, and skips boxes with no overlap", async () => {
    sandboxListMock.mockReturnValue(
      paginator([
        [
          info({
            sandboxId: "sbx_expired",
            startedAt: new Date("2026-10-20T00:00:00.000Z"),
            endAt: new Date("2026-10-20T08:00:00.000Z"),
          }),
          info({
            sandboxId: "sbx_future",
            startedAt: new Date("2026-11-01T00:00:00.000Z"),
          }),
        ],
      ]),
    )

    const { e2bSandboxProvider } = await import("../provider.js")
    const windows = await e2bSandboxProvider.usage!({
      from: "2026-10-20T00:00:00.000Z",
      to: "2026-10-27T00:00:00.000Z",
    })

    expect(windows.map((window) => window.computer)).toEqual(["sbx_expired"])
    expect(windows[0]?.to).toBe("2026-10-20T08:00:00.000Z")
    expect(windows[0]?.activeSec).toBe(8 * 3600)
  })

  it("counts a paused box through now, the documented overestimate", async () => {
    sandboxListMock.mockReturnValue(
      paginator([
        [
          info({
            sandboxId: "sbx_paused",
            state: "paused",
            startedAt: new Date("2026-10-20T00:00:00.000Z"),
            endAt: new Date("2026-11-27T00:00:00.000Z"),
          }),
        ],
      ]),
    )

    const { e2bSandboxProvider } = await import("../provider.js")
    const [window] = await e2bSandboxProvider.usage!({
      from: "2026-10-20T00:00:00.000Z",
      to: "2026-10-27T00:00:00.000Z",
    })

    expect(window?.computer).toBe("sbx_paused")
    expect(window?.to).toBe("2026-10-27T00:00:00.000Z")
    expect(window?.activeSec).toBe(7 * 24 * 3600)
  })

  it("uses the AGENTPROTO_E2B_PRICING override for costEur", async () => {
    vi.stubEnv("AGENTPROTO_E2B_PRICING", JSON.stringify(E2B_PRICING_OVERRIDE))
    sandboxListMock.mockReturnValue(paginator([[info()]]))

    const { e2bSandboxProvider } = await import("../provider.js")
    const [window] = await e2bSandboxProvider.usage!({
      from: "2026-10-20T00:00:00.000Z",
      to: "2026-10-20T01:00:00.000Z",
    })

    const activeSec = 3600
    const vcpuSec = activeSec * 2
    const gibSec = (activeSec * 1024) / 1024
    expect(window?.costEur).toBeCloseTo(
      ((vcpuSec / 3600) * E2B_PRICING_OVERRIDE.usdPerVcpuHour +
        (gibSec / 3600) * E2B_PRICING_OVERRIDE.usdPerGibHour) *
        E2B_PRICING_OVERRIDE.eurPerUsd,
      10,
    )
  })

  it("reports costEur null, never 0, when the pricing override is invalid", async () => {
    sandboxListMock.mockImplementation(() => paginator([[info()]]))

    const { e2bSandboxProvider } = await import("../provider.js")
    for (const invalid of ["not json", JSON.stringify({ usdPerVcpuHour: 0.1 }), "[]"]) {
      vi.stubEnv("AGENTPROTO_E2B_PRICING", invalid)
      const [window] = await e2bSandboxProvider.usage!({
        from: "2026-10-20T00:00:00.000Z",
        to: "2026-10-20T01:00:00.000Z",
      })
      expect(window?.costEur).toBeNull()
    }
  })

  it("uses the W0 defaults when AGENTPROTO_E2B_PRICING is unset", async () => {
    sandboxListMock.mockReturnValue(paginator([[info()]]))

    const { e2bSandboxProvider, DEFAULT_E2B_PRICING } = await import("../provider.js")
    const [window] = await e2bSandboxProvider.usage!({
      from: "2026-10-20T00:00:00.000Z",
      to: "2026-10-20T01:00:00.000Z",
    })

    const activeSec = 3600
    const vcpuSec = activeSec * 2
    const gibSec = (activeSec * 1024) / 1024
    expect(window?.costEur).toBeCloseTo(
      ((vcpuSec / 3600) * DEFAULT_E2B_PRICING.usdPerVcpuHour +
        (gibSec / 3600) * DEFAULT_E2B_PRICING.usdPerGibHour) *
        DEFAULT_E2B_PRICING.eurPerUsd,
      10,
    )
  })

  it("matches no window for an endUser filter, since e2b records none", async () => {
    sandboxListMock.mockReturnValue(paginator([[info()]]))

    const { e2bSandboxProvider } = await import("../provider.js")
    const windows = await e2bSandboxProvider.usage!({
      from: "2026-10-20T00:00:00.000Z",
      to: "2026-10-20T01:00:00.000Z",
      endUser: "user-1",
    })

    expect(windows).toEqual([])
    expect(sandboxListMock).not.toHaveBeenCalled()
  })
})
