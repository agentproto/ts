/**
 * `createGateway({ frameAncestors })` reaches the real app page: the extra
 * sources show up in the `frame-ancestors` CSP of `GET /apps/:appId/ui`, with
 * no `x-frame-options`, and an absent option keeps the built-in header
 * byte for byte. Real `createGateway`, isolated HOME.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { workBoardApp } from "@agentproto/apps"

import type { GatewayHandle } from "../index.js"

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

const DEFAULT_CSP = "frame-ancestors 'self' vscode-webview: vscode-file:"

let home = ""
let gateway: GatewayHandle | undefined

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "gateway-frame-ancestors-"))
  vi.stubEnv("HOME", home)
  vi.stubEnv("AGENTPROTO_HOME", join(home, ".agentproto"))
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})
afterEach(async () => {
  await gateway?.stop()
  gateway = undefined
})

async function boot(frameAncestors?: readonly string[]): Promise<string> {
  const { createGateway } = await import("../index.js")
  const workspace = await mkdtemp(join(home, "ws-"))
  gateway = await createGateway({
    workspace,
    specs: [],
    port: await freePort(),
    boot: false,
    persist: false,
    persistPath: join(home, "sessions.json"),
    ...(frameAncestors ? { frameAncestors } : {}),
  })
  return `${gateway.url}/apps/${encodeURIComponent(workBoardApp.id!)}/ui`
}

describe("createGateway frameAncestors", { timeout: 60_000 }, () => {
  it("adds the configured origins to the app page frame-ancestors and sends no x-frame-options", async () => {
    const url = await boot(["https://web.telegram.org"])
    const res = await fetch(url)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-security-policy")).toBe(
      `${DEFAULT_CSP} https://web.telegram.org`,
    )
    expect(res.headers.get("x-frame-options")).toBeNull()
  })

  it("keeps the built-in header exactly when the option is absent", async () => {
    const url = await boot()
    const res = await fetch(url)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-security-policy")).toBe(DEFAULT_CSP)
    expect(res.headers.get("x-frame-options")).toBeNull()
  })

  it("keeps the built-in header exactly when the list is empty", async () => {
    const url = await boot([])
    const res = await fetch(url)
    expect(res.headers.get("content-security-policy")).toBe(DEFAULT_CSP)
  })
})
