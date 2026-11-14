import { describe, expect, it } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"
import { startHttpServer } from "../http-server.js"
import { createSessionsRegistry } from "../sessions.js"
import { createRuntimeEvents } from "../events.js"

describe("usage rollup HTTP route", () => {
  it("routes usage requests to the sessions registry", async () => {
    const probe = createServer()
    await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve))
    const port = (probe.address() as AddressInfo).port
    await new Promise<void>((resolve, reject) => probe.close(err => err ? reject(err) : resolve()))
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "test", version: "0" })).server,
      conversations: { async open() {}, async appendTurn() {}, async read() { return { meta: {} as never, turns: [] } }, async list() { return [] }, pathFor: id => id },
      events: createRuntimeEvents(),
      heartbeat: { start() {}, stop() {}, async fireNow() {} },
      sessions: createSessionsRegistry({ persist: false }),
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const invalid = await fetch(`http://127.0.0.1:${port}/usage/rollup?window=invalid`)
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toMatchObject({ error: "invalid_window" })
      const valid = await fetch(`http://127.0.0.1:${port}/usage/rollup?window=7d`)
      expect(valid.status).toBe(200)
      expect(await valid.json()).toMatchObject({ window: "7d" })
    } finally {
      await http.stop()
    }
  })
})
