import { describe, it, expect, afterEach } from "vitest"
import { WebSocket } from "ws"
import { createRendezvousServer, RV_CLOSE, type RendezvousServer } from "./server.js"

let servers: RendezvousServer[] = []

async function start(
  opts: Parameters<typeof createRendezvousServer>[0] = {},
): Promise<{ server: RendezvousServer; url: string }> {
  const server = createRendezvousServer(opts)
  servers.push(server)
  const { port } = await server.listen(0, "127.0.0.1")
  return { server, url: `ws://127.0.0.1:${port}/v1` }
}

function dial(url: string, side: "daemon" | "client", token: string): WebSocket {
  return new WebSocket(`${url}?side=${side}&t=${encodeURIComponent(token)}`)
}

function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve())
    ws.once("error", err => reject(err))
  })
}

/** Resolve with the close code when the socket closes (or rejects if it opens
 *  and stays open past the timeout). */
function closedCode(ws: WebSocket, timeoutMs = 2000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("expected close, socket stayed open")), timeoutMs)
    ws.once("close", code => {
      clearTimeout(timer)
      resolve(code)
    })
    ws.once("error", () => {
      // A refused upgrade surfaces as an error then close on the ws client.
    })
  })
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data: Buffer) => resolve(data.toString("utf8")))
    ws.once("error", reject)
  })
}

afterEach(async () => {
  await Promise.all(servers.map(s => s.close().catch(() => {})))
  servers = []
})

describe("rendezvous server — matching + splice", () => {
  it("splices two sockets sharing a token and pipes bytes both ways", async () => {
    const { server, url } = await start()

    const daemon = dial(url, "daemon", "tok-splice")
    await opened(daemon)
    // Daemon is parked, waiting for its counterpart.
    expect(server.stats.parked).toBe(1)

    const client = dial(url, "client", "tok-splice")
    await opened(client)

    // client → daemon
    const atDaemon = nextMessage(daemon)
    client.send("ping-from-client")
    expect(await atDaemon).toBe("ping-from-client")

    // daemon → client
    const atClient = nextMessage(client)
    daemon.send("pong-from-daemon")
    expect(await atClient).toBe("pong-from-daemon")

    expect(server.stats.active).toBe(1)
    expect(server.stats.parked).toBe(0)
    expect(server.stats.totalSplices).toBe(1)

    daemon.close()
    client.close()
  })

  it("does not cross traffic between different tokens", async () => {
    const { url } = await start()
    const dA = dial(url, "daemon", "tokA")
    const dB = dial(url, "daemon", "tokB")
    await Promise.all([opened(dA), opened(dB)])
    const cA = dial(url, "client", "tokA")
    await opened(cA)

    const atClientA = nextMessage(cA)
    // dB is on a different token — its message must never reach cA.
    dB.send("wrong-token-traffic")
    dA.send("correct")
    expect(await atClientA).toBe("correct")

    dA.close()
    dB.close()
    cA.close()
  })

  it("refuses a third connection while a token is actively spliced (single-use / no eavesdropper)", async () => {
    const { server, url } = await start()
    const daemon = dial(url, "daemon", "tok-busy")
    await opened(daemon)
    const client = dial(url, "client", "tok-busy")
    await opened(client)
    // Pair is live; a third socket presenting the same token is refused.
    const intruder = dial(url, "client", "tok-busy")
    const code = await closedCode(intruder)
    expect(code).toBe(RV_CLOSE.tokenInUse)
    expect(server.stats.refused).toBeGreaterThanOrEqual(1)
    daemon.close()
    client.close()
  })

  it("refuses a second socket on the SAME side (double-park)", async () => {
    const { url } = await start()
    const d1 = dial(url, "daemon", "tok-dup")
    await opened(d1)
    const d2 = dial(url, "daemon", "tok-dup")
    const code = await closedCode(d2)
    expect(code).toBe(RV_CLOSE.tokenInUse)
    d1.close()
  })

  it("frees a token after the splice closes (reconnect can reuse it)", async () => {
    const { server, url } = await start()
    const d1 = dial(url, "daemon", "tok-reuse")
    await opened(d1)
    const c1 = dial(url, "client", "tok-reuse")
    await opened(c1)
    expect(server.stats.active).toBe(1)

    // Tear the pair down.
    const c1Closed = new Promise<void>(r => c1.once("close", () => r()))
    d1.close()
    await c1Closed
    // Give the server a tick to run its teardown.
    await new Promise(r => setTimeout(r, 50))
    expect(server.stats.active).toBe(0)

    // Same token can be used for a fresh splice.
    const d2 = dial(url, "daemon", "tok-reuse")
    await opened(d2)
    const c2 = dial(url, "client", "tok-reuse")
    await opened(c2)
    const atD2 = nextMessage(d2)
    c2.send("second-life")
    expect(await atD2).toBe("second-life")
    d2.close()
    c2.close()
  })
})

describe("rendezvous server — hygiene", () => {
  it("closes a parked socket after the park timeout", async () => {
    const { url } = await start({ parkTimeoutMs: 100 })
    const daemon = dial(url, "daemon", "tok-lonely")
    await opened(daemon)
    const code = await closedCode(daemon, 2000)
    expect(code).toBe(RV_CLOSE.parkTimeout)
  })

  it("tears down an idle splice after the idle timeout", async () => {
    const { url } = await start({ idleTimeoutMs: 120 })
    const daemon = dial(url, "daemon", "tok-idle")
    await opened(daemon)
    const client = dial(url, "client", "tok-idle")
    await opened(client)
    const code = await closedCode(client, 2000)
    expect(code).toBe(RV_CLOSE.idleTimeout)
  })

  it("keeps a busy splice alive past the idle window (traffic resets it)", async () => {
    const { url } = await start({ idleTimeoutMs: 150 })
    const daemon = dial(url, "daemon", "tok-busy2")
    await opened(daemon)
    const client = dial(url, "client", "tok-busy2")
    await opened(client)

    // Send a message every 60ms for ~300ms — longer than the idle window, but
    // each message resets it, so the pair must stay open.
    let stillOpen = true
    client.once("close", () => {
      stillOpen = false
    })
    for (let i = 0; i < 5; i++) {
      client.send(`beat-${i}`)
      await new Promise(r => setTimeout(r, 60))
    }
    expect(stillOpen).toBe(true)
    daemon.close()
    client.close()
  })

  it("rejects an oversized message (maxMessageBytes)", async () => {
    const { url } = await start({ maxMessageBytes: 64 })
    const daemon = dial(url, "daemon", "tok-big")
    await opened(daemon)
    const client = dial(url, "client", "tok-big")
    await opened(client)
    const closed = new Promise<number>(r => client.once("close", code => r(code)))
    client.send("x".repeat(200)) // over the 64-byte cap
    const code = await closed
    // ws closes an over-limit connection with 1009 (message too big).
    expect(code === 1009 || code === RV_CLOSE.peerClosed).toBe(true)
    daemon.close()
  })

  it("rate-limits token attempts per IP", async () => {
    const { url } = await start({ rateLimit: { max: 2, windowMs: 60_000 } })
    // First two upgrades from this IP are allowed (they park).
    const a = dial(url, "daemon", "rl-1")
    await opened(a)
    const b = dial(url, "daemon", "rl-2")
    await opened(b)
    // Third upgrade from the same IP is refused at the HTTP upgrade layer.
    const c = dial(url, "daemon", "rl-3")
    await expect(opened(c)).rejects.toBeTruthy()
    a.close()
    b.close()
  })
})

describe("rendezvous server — malformed upgrades", () => {
  it("refuses a missing/invalid side", async () => {
    const { url } = await start()
    const ws = new WebSocket(`${url}?t=sometoken`)
    await expect(opened(ws)).rejects.toBeTruthy()
  })

  it("refuses a missing token", async () => {
    const { url } = await start()
    const ws = new WebSocket(`${url}?side=daemon`)
    await expect(opened(ws)).rejects.toBeTruthy()
  })

  it("refuses the wrong path", async () => {
    const { server } = await start()
    const addr = server.httpServer.address()
    const port = addr && typeof addr === "object" ? addr.port : 0
    const ws = new WebSocket(`ws://127.0.0.1:${port}/wrong?side=daemon&t=x`)
    await expect(opened(ws)).rejects.toBeTruthy()
  })
})
