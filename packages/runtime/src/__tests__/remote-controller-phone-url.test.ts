/**
 * `RemoteController.enable()`'s `phoneUrl` (PHONE-PLAN.md P1.2) — a single
 * link a phone can open, with the bearer riding in a URL *fragment*
 * (`#token=`), never a `?` query string (fragments never reach a server).
 * Two shapes, chosen by `isSessionChatInstalled`:
 *   - installed:     `<publicUrl>/apps/@agentik/session-chat/ui#token=<t>`
 *   - not installed: `https://cli.agentproto.sh/panel#daemon=<publicUrl>&token=<t>`
 * Mocks the quick-tunnel provider so no real `cloudflared` process is
 * spawned — `start()` resolves immediately with a fake public URL.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const FAKE_PUBLIC_URL = "https://fake-tunnel.trycloudflare.com"

vi.mock("../remote-providers/quick.js", () => ({
  quickTunnelProvider: () => ({
    id: "quick",
    async start() {
      return { publicUrl: FAKE_PUBLIC_URL, pid: 4242 }
    },
    async stop() {},
  }),
}))

import { RemoteController } from "../remote-controller.js"

describe("RemoteController.enable() — phoneUrl", () => {
  let dir: string

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it("links straight into session-chat when it's installed", async () => {
    dir = await mkdtemp(join(tmpdir(), "agentproto-remote-phoneurl-"))
    const controller = new RemoteController({
      workspace: dir,
      port: 18790,
      isSessionChatInstalled: () => true,
    })
    const result = await controller.enable({})
    expect(result.bearerToken).toBeTruthy()
    expect(result.phoneUrl).toBe(
      `${FAKE_PUBLIC_URL}/apps/@agentik/session-chat/ui#token=${result.bearerToken}`,
    )
  })

  it("falls back to the hosted panel when session-chat isn't installed", async () => {
    dir = await mkdtemp(join(tmpdir(), "agentproto-remote-phoneurl-"))
    const controller = new RemoteController({
      workspace: dir,
      port: 18790,
      isSessionChatInstalled: () => false,
    })
    const result = await controller.enable({})
    expect(result.bearerToken).toBeTruthy()
    expect(result.phoneUrl).toBe(
      `https://cli.agentproto.sh/panel#daemon=${encodeURIComponent(FAKE_PUBLIC_URL)}&token=${result.bearerToken}`,
    )
  })

  it("also falls back to the hosted panel when isSessionChatInstalled is omitted", async () => {
    dir = await mkdtemp(join(tmpdir(), "agentproto-remote-phoneurl-"))
    const controller = new RemoteController({ workspace: dir, port: 18790 })
    const result = await controller.enable({})
    expect(result.phoneUrl).toBe(
      `https://cli.agentproto.sh/panel#daemon=${encodeURIComponent(FAKE_PUBLIC_URL)}&token=${result.bearerToken}`,
    )
  })

  it("omits phoneUrl for a passthrough tunnel (targetPort != gateway port)", async () => {
    dir = await mkdtemp(join(tmpdir(), "agentproto-remote-phoneurl-"))
    const controller = new RemoteController({
      workspace: dir,
      port: 18790,
      isSessionChatInstalled: () => true,
    })
    const result = await controller.enable({ targetPort: 54371 })
    expect(result.exposesGateway).toBe(false)
    expect(result.bearerToken).toBeUndefined()
    expect(result.phoneUrl).toBeUndefined()
  })
})
