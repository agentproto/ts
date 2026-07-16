/**
 * Regression: a gateway must not write session rows into the developer's
 * real ~/.agentproto/sessions.json.
 *
 * `createGateway` used to construct its sessions registry without passing
 * persist/persistPath, and `createSessionsRegistry` defaults `persist` to
 * true against a `homedir()`-resolved path — so every test that booted a
 * gateway (the sandbox suites) persisted its `fake-cli (test double)` rows
 * into the real file. `loadHistorySnapshot` reloads that file at daemon
 * boot, so the fakes came back as history and, against HISTORY_CAP (200),
 * evicted genuine sessions.
 *
 * Both directions are asserted here: `persist: false` writes nothing, and
 * the default still writes — otherwise the first assertion would pass just
 * as well against a gateway that never persisted anything at all.
 *
 * Every case pins `persistPath` into a tmpdir, so a regression fails the
 * assertion rather than quietly touching the real home the way the bug did.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"

import { createGateway, type GatewayHandle } from "../index.js"
import type { AgentSessionLike } from "../sessions.js"

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

const fakeAgent = (): AgentSessionLike => ({
  sessionId: "acp-persist-probe",
  async *send() {
    yield { kind: "turn-end", reason: "completed" }
  },
  async cancel() {},
  async close() {},
})

describe("createGateway — sessions persistence is opt-outable", () => {
  const dirs: string[] = []
  const gateways: GatewayHandle[] = []
  let prevHome: string | undefined
  let home: string

  // The persist-on case below deliberately exercises the production default,
  // which also persists the sibling stores (policies.json / cron-jobs.json)
  // off `homedir()` — those have no path knob. Swap HOME for the whole block
  // so this test can't do the very thing it exists to prevent.
  beforeEach(async () => {
    prevHome = process.env.HOME
    home = await mkdtemp(join(tmpdir(), "agentproto-gateway-persist-home-"))
    process.env.HOME = home
  })

  afterEach(async () => {
    for (const gw of gateways.splice(0)) await gw.stop().catch(() => {})
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    await rm(home, { recursive: true, force: true })
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  async function bootGateway(persist: boolean): Promise<{
    gateway: GatewayHandle
    persistPath: string
  }> {
    const home = await mkdtemp(join(tmpdir(), "agentproto-gateway-persist-"))
    const workspace = await mkdtemp(join(tmpdir(), "agentproto-gateway-persist-ws-"))
    dirs.push(home, workspace)
    const persistPath = join(home, "sessions.json")
    const gateway = await createGateway({
      workspace,
      specs: [],
      port: await freePort(),
      boot: false,
      persist,
      persistPath,
    })
    gateways.push(gateway)
    return { gateway, persistPath }
  }

  it("persist: false — a spawned session is never written to the sessions file", async () => {
    const { gateway, persistPath } = await bootGateway(false)
    gateway.sessions.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent(),
      adapterSlug: "fake-cli",
    })
    // The row is live in memory — the registry works, it just has nowhere
    // on disk to put it.
    expect(gateway.sessions.list()).toHaveLength(1)

    // shutdown() is the flush point (see the sessions.json round-trip test),
    // so the file can only appear here if persistence ran anyway.
    await gateway.stop()
    expect(existsSync(persistPath)).toBe(false)
  })

  it("default (persist on) — the same spawn IS written, so the check above is not vacuous", async () => {
    const { gateway, persistPath } = await bootGateway(true)
    const desc = gateway.sessions.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent(),
      adapterSlug: "fake-cli",
    })
    await gateway.stop()

    expect(existsSync(persistPath)).toBe(true)
    const raw = JSON.parse(readFileSync(persistPath, "utf8"))
    expect(raw.sessions).toHaveLength(1)
    expect(raw.sessions[0].id).toBe(desc.id)
  })
})
