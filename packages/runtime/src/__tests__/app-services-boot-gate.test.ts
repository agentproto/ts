/**
 * `GatewayHandle.reensureAppServicesOnBoot()` — the thin wrapper serve.ts
 * calls (index.ts). Everything about WHAT it does once enabled
 * (force-replacing owners) is covered at the lower layers
 * (app-services.test.ts's `reensureAppServiceOwners`,
 * app-services-launcher.test.ts's `reensureInstalledAppServicesOnBoot`); this
 * file is only about the wrapper's own `daemon.resumeSessionsOnBoot` gate —
 * the same opt-in knob `resumeSessionsOnBoot()` / `continueInterruptedOnBoot()`
 * short-circuit on.
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

describe("GatewayHandle.reensureAppServicesOnBoot — resumeSessionsOnBoot gate", () => {
  const dirs: string[] = []
  const gateways: GatewayHandle[] = []

  afterEach(async () => {
    for (const gw of gateways.splice(0)) await gw.stop().catch(() => {})
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  async function bootGateway(resumeSessionsOnBoot: boolean): Promise<GatewayHandle> {
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
      resumeSessionsOnBoot,
    })
    gateways.push(gateway)
    return gateway
  }

  it("daemon.resumeSessionsOnBoot off — short-circuits to enabled:false, no app scan", async () => {
    const gateway = await bootGateway(false)
    expect(await gateway.reensureAppServicesOnBoot()).toEqual({
      enabled: false,
      apps: 0,
      spawned: 0,
      errors: [],
    })
  })

  it("daemon.resumeSessionsOnBoot on, no installed apps — enabled:true, nothing to re-ensure", async () => {
    const gateway = await bootGateway(true)
    expect(await gateway.reensureAppServicesOnBoot()).toEqual({
      enabled: true,
      apps: 0,
      spawned: 0,
      errors: [],
    })
  })
})
