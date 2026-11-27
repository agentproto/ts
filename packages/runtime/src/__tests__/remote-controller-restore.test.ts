/**
 * `RemoteController.restore()`: after a restart the persisted remote state
 * (token hash only) re-arms the bearer gate, so the holder's existing token
 * keeps working and gateway-exposing tunnels are accepted again.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

vi.mock("../remote-providers/quick.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../remote-providers/quick.js")>()),
  quickTunnelProvider: () => ({
    id: "quick",
    async start() {
      return { publicUrl: "https://fake-tunnel.trycloudflare.com", pid: 4242 }
    },
    async stop() {},
  }),
}))

import { RemoteController } from "../remote-controller.js"
import { bearerTokenMatches } from "../http-server.js"

describe("RemoteController.restore()", () => {
  let dir: string
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it("re-arms the bearer gate from the persisted hash after a restart", async () => {
    dir = await mkdtemp(join(tmpdir(), "agentproto-remote-restore-"))
    const first = new RemoteController({ workspace: dir, port: 18790 })
    const { bearerToken } = await first.enable({})
    expect(bearerToken).toBeTruthy()

    const second = new RemoteController({ workspace: dir, port: 18790 })
    expect(second.readAuth().mode).toBe("none")
    expect(await second.restore()).toBe(true)

    const auth = second.readAuth()
    expect(auth.mode).toBe("bearer")
    expect(auth.token).toBeUndefined()
    expect(bearerTokenMatches(auth, bearerToken)).toBe(true)
    expect(bearerTokenMatches(auth, "wrong-token")).toBe(false)
    expect(bearerTokenMatches(auth, undefined)).toBe(false)
    expect(second.status().enabled).toBe(true)

    await second.disable()
    expect(second.readAuth().mode).toBe("none")
  })

  it("does nothing when no remote state was persisted", async () => {
    dir = await mkdtemp(join(tmpdir(), "agentproto-remote-restore-"))
    const c = new RemoteController({ workspace: dir, port: 18790 })
    expect(await c.restore()).toBe(false)
    expect(c.readAuth().mode).toBe("none")
  })

  it("does not restore a passthrough tunnel (no gateway gate to re-arm)", async () => {
    dir = await mkdtemp(join(tmpdir(), "agentproto-remote-restore-"))
    const first = new RemoteController({ workspace: dir, port: 18790 })
    await first.enable({ targetPort: 5173 })
    const second = new RemoteController({ workspace: dir, port: 18790 })
    expect(await second.restore()).toBe(false)
    expect(second.readAuth().mode).toBe("none")
  })
})
