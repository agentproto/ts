/**
 * The computer controller's gc surface: LIST the computers it still holds
 * (`GET /v1/computers`) and DESTROY one with `?force=true` (the flag that
 * lets the gc remove a box whose controller-side session slots are stale).
 *
 * The controller here is the in-process fake (`FakeController`), so the
 * tests exercise the real HTTP shapes: the request paths, the query string
 * and the contract-checked bodies.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { ComputerControllerClient, ComputerApiError } from "../client.js"
import { computerSandboxProvider } from "../provider.js"
import { FakeController } from "./fake-controller.js"

const SERVICE_TOKEN = "svc-secret-gc-aaaaaaaaaaaaaaaa"

describe("computer controller: the gc surface", () => {
  let controller: FakeController

  beforeEach(async () => {
    controller = new FakeController({ token: SERVICE_TOKEN })
    await controller.start()
  })

  afterEach(async () => {
    await controller.stop()
  })

  function client(): ComputerControllerClient {
    return new ComputerControllerClient({
      baseUrl: controller.url,
      token: SERVICE_TOKEN,
      tenantId: "tenant-a",
    })
  }

  it("lists every computer the controller still holds", async () => {
    const c = client()
    const created = await c.createComputer({
      template: "node",
      tenantId: "tenant-a",
      memoryMiB: 4096,
    })
    const listed = await c.listComputers()
    expect(listed.map(e => e.name)).toEqual([created.id])
    expect(listed[0]?.state).toBe("running")
  })

  it("reports a controller failure on the list route", async () => {
    const broken = new FakeController({ token: SERVICE_TOKEN, listStatus: 500, listError: "boom" })
    await broken.start()
    try {
      const c = new ComputerControllerClient({
        baseUrl: broken.url,
        token: SERVICE_TOKEN,
        tenantId: "tenant-a",
      })
      await expect(c.listComputers()).rejects.toBeInstanceOf(ComputerApiError)
    } finally {
      await broken.stop()
    }
  })

  it("deletes a box with force=true, even while the controller counts a session", async () => {
    const c = client()
    const created = await c.createComputer({ template: "node", tenantId: "tenant-a" })
    // A stale session slot: the box must still be destroyable, but only
    // when the caller forces it.
    await c.attach(created.id)
    await expect(c.remove(created.id)).rejects.toBeInstanceOf(ComputerApiError)
    await c.remove(created.id, { force: true })
    expect(controller.deletes).toEqual([{ id: created.id, force: true }])
    expect(await c.listComputers()).toEqual([])
  })

  it("the provider lists its boxes for the gc", async () => {
    const c = client()
    const created = await c.createComputer({ template: "node", tenantId: "tenant-a" })
    process.env.COMPUTER_CONTROLLER_URL = controller.url
    process.env.COMPUTER_CONTROLLER_TOKEN = SERVICE_TOKEN
    process.env.COMPUTER_TENANT_ID = "tenant-a"
    try {
      const boxes = await computerSandboxProvider.listBoxes?.()
      expect(boxes).toEqual([{ id: created.id, state: "running", sessions: 0 }])
    } finally {
      delete process.env.COMPUTER_CONTROLLER_URL
      delete process.env.COMPUTER_CONTROLLER_TOKEN
      delete process.env.COMPUTER_TENANT_ID
    }
  })
})
