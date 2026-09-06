/**
 * `serveMcp`'s transport `onerror` used to call bare `console.error` once per
 * failure. stderr is a launchd-redirected REGULAR FILE in production, so each
 * of those is a synchronous disk write on the event loop — and the callers
 * that trigger onerror (malformed probes, clients retrying because they're
 * already getting resets) arrive in bursts. One production incident (~24
 * concurrent sessions, `Parse error: Invalid JSON` loop) grew `daemon.log`
 * by 3.2MB this way; see `.plans/mcp-transport-degradation-diagnosis.md`.
 *
 * The fix routes both MCP error logs through `createReconnectLogGate`
 * (first failure logs immediately, repeats within the window are swallowed
 * and surface later as a suppressed-count suffix). This test replays the
 * incident's shape — a burst of malformed-JSON POSTs — and asserts exactly
 * one `[mcp transport.onerror]` line is emitted for the whole burst.
 */

import { describe, it, expect, vi } from "vitest"
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

/** POST a malformed (non-JSON) body to /mcp — the incident's probe shape. */
async function postMalformed(port: number): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: "this is not json{{{",
  })
  // Drain so the transport finishes the request before the next probe.
  await res.text().catch(() => "")
  return res.status
}

describe("/mcp transport error log gate", () => {
  it("logs one line for a burst of malformed probes, not one per probe", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const statuses: number[] = []
      for (let i = 0; i < 5; i++) statuses.push(await postMalformed(port))

      // The wire behavior is unchanged: every probe still gets its JSON-RPC
      // parse-error response (400), none escalates to a 500.
      expect(statuses).toEqual([400, 400, 400, 400, 400])

      const onerrorLines = errorSpy.mock.calls.filter(
        args => typeof args[0] === "string" && args[0].includes("[mcp transport.onerror]"),
      )
      // First failure logs immediately; the four repeats inside the gate
      // window are swallowed (they'd surface as a "(N failures suppressed)"
      // suffix on the next post-window emission).
      expect(onerrorLines.length).toBe(1)
    } finally {
      errorSpy.mockRestore()
      await http.stop()
    }
  })
})
