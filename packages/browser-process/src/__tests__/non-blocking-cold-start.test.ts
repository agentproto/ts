/**
 * Non-blocking cold-start behaviour for `ensureBrowserProcess`.
 *
 * Uses a tiny local http server as the fake health endpoint and flips its
 * readiness with a boolean so the cases are deterministic and fast (no real
 * service, no sleeps longer than a couple polls).
 */

import { afterEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { ensureBrowserProcess } from "../index.js"

let server: Server | undefined

/** Spin up a health endpoint whose readiness is driven by `state.ready`. */
async function startHealthServer(state: { ready: boolean }): Promise<string> {
  server = createServer((_req, res) => {
    if (state.ready) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
    } else {
      res.writeHead(503)
      res.end("not ready")
    }
  })
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve))
  const { port } = server!.address() as AddressInfo
  return `http://127.0.0.1:${port}/health`
}

afterEach(async () => {
  if (server) {
    await new Promise<void>(resolve => server!.close(() => resolve()))
    server = undefined
  }
})

describe("ensureBrowserProcess — non-blocking cold start", () => {
  it("(a) already healthy → wasAlreadyRunning:true, healthy:true, no launch", async () => {
    const healthUrl = await startHealthServer({ ready: true })
    let launched = false
    const res = await ensureBrowserProcess({
      kind: "fake",
      healthUrl,
      launch: () => {
        launched = true
        return null
      },
      initialWaitMs: 1_000,
      intervalMs: 50,
    })
    expect(res.wasAlreadyRunning).toBe(true)
    expect(res.healthy).toBe(true)
    expect(launched).toBe(false)
  })

  it("(b) becomes healthy within initialWaitMs → wasAlreadyRunning:false, healthy:true", async () => {
    const state = { ready: false }
    const healthUrl = await startHealthServer(state)
    // Flip to ready shortly after launch, well within the initial window.
    const res = await ensureBrowserProcess({
      kind: "fake",
      healthUrl,
      launch: () => {
        setTimeout(() => {
          state.ready = true
        }, 80)
        return null
      },
      initialWaitMs: 2_000,
      intervalMs: 50,
    })
    expect(res.wasAlreadyRunning).toBe(false)
    expect(res.healthy).toBe(true)
  })

  it("(c) NOT healthy within initialWaitMs → returns promptly, healthy:false, no throw", async () => {
    const state = { ready: false }
    const healthUrl = await startHealthServer(state)
    const start = process.hrtime.bigint()
    const res = await ensureBrowserProcess({
      kind: "fake",
      healthUrl,
      launch: () => null,
      initialWaitMs: 200, // bounded window the service never meets
      // Generous background timeout — we assert it does NOT block on this.
      timeoutMs: 30_000,
      intervalMs: 50,
    })
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6
    expect(res.wasAlreadyRunning).toBe(false)
    expect(res.healthy).toBe(false)
    // Returned on the bounded window, not the 30s background timeout.
    expect(elapsedMs).toBeLessThan(2_000)
    // Let the detached background waitHealthy settle before the server closes
    // so it resolves/cancels cleanly instead of erroring against a dead port.
    state.ready = true
    await new Promise<void>(resolve => setTimeout(resolve, 120))
  })
})
