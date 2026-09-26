/**
 * `GET /events` (the runtime bus SSE) must not go quiet: relays cut a silent
 * stream (the tunnel server's 120s inter-chunk idle bound on pairing and
 * `serve --connect` channels, proxies, the rendezvous idle timeout). Same
 * 25s keep-alive comment as the other SSE routes.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

function noopConversations(): ConversationStore {
  return {
    async open() {},
    async appendTurn() {},
    async read() {
      return { meta: {} as never, turns: [] }
    },
    async list() {
      return []
    },
    pathFor: (id: string) => id,
  }
}

function noopHeartbeat(): HeartbeatRunner {
  return { start() {}, stop() {}, async fireNow() {} }
}

async function mcpServerFactory() {
  return (await createMcpServer({ specs: [], name: "main", version: "0" }))
    .server
}

async function start(port: number) {
  return startHttpServer({
    port,
    auth: { mode: "none" },
    mcpServerFactory,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    meta: { workspace: process.cwd(), registered: [] },
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe("GET /events keep-alive", () => {
  it("writes a keep-alive comment every 25s on a quiet bus, and stops on close", async () => {
    // Only the interval is faked: sockets and the rest keep real timers.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    const port = await freePort()
    const http = await start(port)
    const ac = new AbortController()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/events`, { signal: ac.signal })
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      let seen = ""
      const readUntil = async (needle: string): Promise<void> => {
        while (!seen.includes(needle)) {
          const { value, done } = await reader.read()
          if (done) throw new Error(`stream ended before ${JSON.stringify(needle)}`)
          seen += dec.decode(value, { stream: true })
        }
      }
      await readUntil(": connected\n\n")
      expect(seen).not.toContain("keep-alive")

      vi.advanceTimersByTime(25_000)
      await readUntil(": keep-alive\n\n")
      vi.advanceTimersByTime(25_000)
      await readUntil(": keep-alive\n\n: keep-alive\n\n")

      const before = vi.getTimerCount()
      ac.abort()
      await vi.waitFor(() => expect(vi.getTimerCount()).toBeLessThan(before))
    } finally {
      ac.abort()
      await http.stop()
    }
  })
})
