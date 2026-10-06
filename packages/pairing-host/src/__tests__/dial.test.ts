import { describe, it, expect, afterEach } from "vitest"
import { createServer, type Server, type Socket } from "node:net"
import type { AddressInfo } from "node:net"
import { dialRendezvous } from "../index.js"

describe("dialRendezvous abort during CONNECTING", () => {
  let server: Server
  const sockets: Socket[] = []
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.destroy()
    await new Promise<void>(r => server.close(() => r()))
  })

  async function silentServer(): Promise<string> {
    server = createServer(s => sockets.push(s))
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r))
    return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  it("rejects cleanly and raises no unhandled 'error' when aborted mid-handshake", async () => {
    const url = await silentServer()
    const uncaught: unknown[] = []
    const onUncaught = (e: unknown): void => void uncaught.push(e)
    process.on("uncaughtException", onUncaught)
    try {
      const ac = new AbortController()
      const p = dialRendezvous(url, ac.signal)
      setTimeout(() => ac.abort(), 50)
      await expect(p).rejects.toThrow("dial aborted")
      // ws emits its "closed before the connection was established" error on a later tick
      await new Promise(r => setTimeout(r, 100))
      expect(uncaught).toEqual([])
    } finally {
      process.off("uncaughtException", onUncaught)
    }
  })

  it("rejects when the signal is already aborted", async () => {
    const url = await silentServer()
    const ac = new AbortController()
    ac.abort()
    await expect(dialRendezvous(url, ac.signal)).rejects.toThrow("dial aborted")
    await new Promise(r => setTimeout(r, 100))
  })
})
