/**
 * The common inventory and usage surface: `provider.list()` keeps the W0b
 * list fields, `provider.usage()`/`client.getUsage()` map the controller's
 * `GET /v1/usage` windows exactly, and fields the controller does not
 * report stay undefined rather than being invented.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import type { UsageWindow } from "@agentproto/computer-api"
import { ComputerControllerClient } from "../client.js"
import { computerSandboxProvider } from "../provider.js"
import { FakeController, type FakeControllerOptions } from "./fake-controller.js"

const SERVICE_TOKEN = "svc-secret-list-usage-aaaaaaaaaaaa"

describe("computer sandbox: common list and usage surface", () => {
  let controller: FakeController
  const savedEnv = {
    url: process.env.COMPUTER_CONTROLLER_URL,
    token: process.env.COMPUTER_CONTROLLER_TOKEN,
    tenant: process.env.COMPUTER_TENANT_ID,
  }

  async function start(options: Partial<FakeControllerOptions> = {}): Promise<void> {
    controller = new FakeController({ token: SERVICE_TOKEN, ...options })
    await controller.start()
    process.env.COMPUTER_CONTROLLER_URL = controller.url
    process.env.COMPUTER_CONTROLLER_TOKEN = SERVICE_TOKEN
    process.env.COMPUTER_TENANT_ID = "tenant-a"
  }

  beforeEach(() => {
    // Each test starts its own controller; env is set there.
  })

  afterEach(async () => {
    await controller.stop()
    for (const [key, value] of [
      ["COMPUTER_CONTROLLER_URL", savedEnv.url],
      ["COMPUTER_CONTROLLER_TOKEN", savedEnv.token],
      ["COMPUTER_TENANT_ID", savedEnv.tenant],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  function client(): ComputerControllerClient {
    return new ComputerControllerClient({
      baseUrl: controller.url,
      token: SERVICE_TOKEN,
      tenantId: "tenant-a",
    })
  }

  const createdAt = "2026-10-01T00:00:00.000Z"
  const lastActivityAt = "2026-10-01T00:30:00.000Z"

  it("list keeps tenantId, endUser, cpus, host and the other W0b fields", async () => {
    await start({
      listExtra: {
        tenantId: "tenant-a",
        endUser: "user-1",
        cpus: 4,
        hostId: "box-kvm-a",
        hostUrl: "https://box-kvm-a.internal",
        memoryMiB: 4096,
        createdAt,
        lastActivityAt,
        egressIp: { id: "eg1", publicIp: "203.0.113.7" },
      },
    })
    const created = await client().createComputer({ template: "node", tenantId: "tenant-a" })

    const boxes = await computerSandboxProvider.list?.()

    expect(boxes).toEqual([
      {
        id: created.id,
        provider: "computer",
        state: "running",
        tenantId: "tenant-a",
        endUser: "user-1",
        host: "box-kvm-a",
        cpus: 4,
        memoryMiB: 4096,
        createdAt,
        lastActivityAt,
        egressIp: "203.0.113.7",
        sessions: 0,
      },
    ])
  })

  it("list leaves unreported fields undefined instead of inventing them", async () => {
    await start()
    const created = await client().createComputer({ template: "node", tenantId: "tenant-a" })

    const boxes = await computerSandboxProvider.list?.()

    expect(boxes).toHaveLength(1)
    const box = boxes?.[0]
    expect(box && { id: box.id, provider: box.provider, state: box.state, sessions: box.sessions }).toEqual({
      id: created.id,
      provider: "computer",
      state: "running",
      sessions: 0,
    })
    expect(box?.tenantId).toBeUndefined()
    expect(box?.endUser).toBeUndefined()
    expect(box?.host).toBeUndefined()
    expect(box?.cpus).toBeUndefined()
    expect(box?.memoryMiB).toBeUndefined()
    expect(box?.createdAt).toBeUndefined()
    expect(box?.lastActivityAt).toBeUndefined()
    expect(box?.egressIp).toBeUndefined()
    expect(box?.costEur).toBeUndefined()
    expect(Object.keys(box ?? {}).sort()).toEqual(["id", "provider", "sessions", "state"])
  })

  it("listBoxes keeps working from the same mapping", async () => {
    await start({
      listExtra: { tenantId: "tenant-a", endUser: "user-1", cpus: 4, hostId: "box-kvm-a", memoryMiB: 2048, createdAt },
    })
    const created = await client().createComputer({ template: "node", tenantId: "tenant-a" })

    const boxes = await computerSandboxProvider.listBoxes?.()

    expect(boxes).toEqual([{ id: created.id, state: "running", sessions: 0, memoryMiB: 2048, createdAt }])
  })

  it("usage maps every W0 window field exactly", async () => {
    const windows: UsageWindow[] = [
      {
        computer: "cmp-001",
        tenantId: "tenant-a",
        endUser: "user-1",
        provider: "computer",
        host: "box-kvm-a",
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-10-01T01:00:00.000Z",
        activeSec: 3600,
        vcpuSec: 7200,
        gibSec: 1800,
        costEur: 0.1023,
        eventId: "01J00000000000000000000000",
      },
    ]
    await start({ usageWindows: windows })

    const usage = await computerSandboxProvider.usage?.({
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-02T00:00:00.000Z",
    })

    expect(usage).toEqual(windows)
    expect(controller.usageRequests).toEqual([
      { from: "2026-10-01T00:00:00.000Z", to: "2026-10-02T00:00:00.000Z", endUser: undefined },
    ])
  })

  it("getUsage passes endUser and returns the controller totals", async () => {
    await start({
      usageWindows: [
        {
          computer: "cmp-001",
          tenantId: "tenant-a",
          endUser: "user-1",
          provider: "computer",
          from: "2026-10-01T00:00:00.000Z",
          to: "2026-10-01T01:00:00.000Z",
          activeSec: 3600,
          vcpuSec: 7200,
          gibSec: 1800,
          costEur: 0.25,
        },
        {
          computer: "cmp-002",
          tenantId: "tenant-a",
          endUser: "user-2",
          provider: "computer",
          from: "2026-10-01T00:00:00.000Z",
          to: "2026-10-01T01:00:00.000Z",
          activeSec: 60,
          vcpuSec: 120,
          gibSec: 30,
          costEur: 0.01,
        },
      ],
      usageUnallocatedEur: 1.5,
    })

    const body = await client().getUsage({
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-02T00:00:00.000Z",
      endUser: "user-1",
    })

    expect(controller.usageRequests).toEqual([
      { from: "2026-10-01T00:00:00.000Z", to: "2026-10-02T00:00:00.000Z", endUser: "user-1" },
    ])
    expect(body.windows.map((window) => window.endUser)).toEqual(["user-1"])
    expect(body.totals).toEqual({ activeSec: 3600, vcpuSec: 7200, gibSec: 1800, costEur: 0.25 })
    expect(body.host).toEqual({ unallocatedEur: 1.5 })
  })

  it("usage leaves optional fields absent, never invented", async () => {
    const windows: UsageWindow[] = [
      {
        computer: "cmp-002",
        tenantId: "tenant-a",
        provider: "e2b",
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-10-01T01:00:00.000Z",
        activeSec: 60,
        vcpuSec: 120,
        gibSec: 30,
        costEur: 0.01,
      },
    ]
    await start({ usageWindows: windows })

    const usage = await computerSandboxProvider.usage?.({
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-02T00:00:00.000Z",
    })

    expect(usage).toEqual(windows)
    const window = usage?.[0]
    expect(window && "endUser" in window).toBe(false)
    expect(window && "host" in window).toBe(false)
    expect(window && "eventId" in window).toBe(false)
  })

  it("usage surfaces a controller failure as ComputerApiError", async () => {
    await start({ usageStatus: 500, usageError: "boom" })

    await expect(
      computerSandboxProvider.usage?.({
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-10-02T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ name: "ComputerApiError", status: 500, code: "boom" })
  })
})
