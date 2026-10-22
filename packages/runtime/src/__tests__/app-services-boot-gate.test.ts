/**
 * `GatewayHandle.reensureAppServicesOnBoot()` — the thin wrapper serve.ts
 * calls (index.ts). Everything about WHAT it does once enabled
 * (force-replacing owners) is covered at the lower layers
 * (app-services.test.ts's `reensureAppServiceOwners`,
 * app-services-launcher.test.ts's `reensureInstalledAppServicesOnBoot`); this
 * file is only about the wrapper's own `daemon.resumeServicesOnBoot` gate —
 * its OWN knob, default ON (audit F-11: decoupled from the unrelated
 * `daemon.resumeSessionsOnBoot` opt-in, which governs agent adapters).
 */

import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"

import { createGateway, type GatewayHandle } from "../index.js"

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

describe("GatewayHandle.reensureAppServicesOnBoot — resumeServicesOnBoot gate", () => {
  const dirs: string[] = []
  const gateways: GatewayHandle[] = []

  afterEach(async () => {
    for (const gw of gateways.splice(0)) await gw.stop().catch(() => {})
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  async function bootGateway(opts: { resumeSessionsOnBoot?: boolean; resumeServicesOnBoot?: boolean }): Promise<GatewayHandle> {
    const workspace = await mkdtemp(join(tmpdir(), "agentproto-app-services-boot-gate-ws-"))
    const home = await mkdtemp(join(tmpdir(), "agentproto-app-services-boot-gate-home-"))
    dirs.push(workspace, home)
    const gateway = await createGateway({
      workspace,
      specs: [],
      port: await freePort(),
      boot: false,
      persist: false,
      persistPath: join(home, "sessions.json"),
      ...opts,
    })
    gateways.push(gateway)
    return gateway
  }

  it("default — enabled: services re-ensure WITHOUT any resumeSessionsOnBoot opt-in", async () => {
    const gateway = await bootGateway({})
    expect(await gateway.reensureAppServicesOnBoot()).toEqual({
      enabled: true,
      apps: 0,
      spawned: 0,
      errors: [],
    })
    // The decoupling is the point: the resume passes stay OFF (their own
    // default) while services re-ensure regardless.
    expect(await gateway.resumeSessionsOnBoot()).toEqual(
      expect.objectContaining({ enabled: false }),
    )
  })

  it("resumeServicesOnBoot off — short-circuits to enabled:false, no app scan", async () => {
    const gateway = await bootGateway({ resumeServicesOnBoot: false })
    expect(await gateway.reensureAppServicesOnBoot()).toEqual({
      enabled: false,
      apps: 0,
      spawned: 0,
      errors: [],
    })
  })

  it("resumeServicesOnBoot off while resumeSessionsOnBoot on — both knobs respected", async () => {
    const gateway = await bootGateway({ resumeSessionsOnBoot: true, resumeServicesOnBoot: false })
    expect(await gateway.reensureAppServicesOnBoot()).toEqual(
      expect.objectContaining({ enabled: false }),
    )
    expect(await gateway.resumeSessionsOnBoot()).toEqual(
      expect.objectContaining({ enabled: true }),
    )
  })

  it("resumeSessionsOnBoot off does NOT disable services (the decoupling)", async () => {
    const gateway = await bootGateway({ resumeSessionsOnBoot: false })
    expect(await gateway.reensureAppServicesOnBoot()).toEqual(
      expect.objectContaining({ enabled: true }),
    )
  })
})
