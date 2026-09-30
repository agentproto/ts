/**
 * `/device-prompt/:sessionId` (BOOTSTRAP P4 item 1) — the RECEIVING side of
 * `device_prompt` / `agentproto devices prompt`: this daemon self-proxies the
 * request onto its own `POST /sessions/:id/prompt` for a paired HOST-scoped
 * controller. Same two-gate shape as `/device-spawn/*`
 * (`device-spawn-http-routes.test.ts`) — host-scope header, then the
 * `deviceSpawnAllow` opt-in — exercised over the real REST layer via
 * `startHttpServer`, including the end-to-end queueing behaviour once the
 * gates pass (a mid-turn session's prompt lands in the FIFO, never
 * dispatched early).
 */

import { describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import { startHttpServer, HOST_SCOPE_HEADER, type AgentAdapterResolver } from "../http-server.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"
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
  return {
    start() {},
    stop() {},
    async fireNow() {},
  }
}

async function mcpServerFactory() {
  const { createMcpServer } = await import("@agentproto/mcp-server")
  return (await createMcpServer({ specs: [], name: "main", version: "0" })).server
}

const resolveAgentAdapter: AgentAdapterResolver = async () => ({
  async startSession() {
    throw new Error("not used in this test")
  },
  commandPreview: "mock-adapter",
})

let acpCounter = 0
/** A mid-turn session: the turn generator never resolves, so the session
 *  stays busy and an enqueued prompt must sit in the FIFO. */
function busyAgentSession(prefix: string): AgentSessionLike {
  return {
    sessionId: `${prefix}_${acpCounter++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      await new Promise(() => {})
    },
    async cancel() {},
    async close() {},
  }
}

async function withServer(
  opts: { deviceSpawnAllow?: boolean },
  fn: (base: string, registry: ReturnType<typeof createSessionsRegistry>) => Promise<void>,
): Promise<void> {
  const registry = createSessionsRegistry({ persist: false })
  const port = await freePort()
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    mcpServerFactory,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    sessions: registry,
    resolveAgentAdapter,
    meta: { workspace: process.cwd(), registered: [] },
    ...opts,
  })
  try {
    await fn(`http://127.0.0.1:${port}`, registry)
  } finally {
    await http.stop()
  }
}

function devicePrompt(
  base: string,
  sessionId: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}/device-prompt/${encodeURIComponent(sessionId)}?wait=false`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  })
}

describe("/device-prompt/:sessionId (the device being prompted)", () => {
  it("403s without the host-scope header, even with spawn allowed", async () => {
    await withServer({ deviceSpawnAllow: true }, async base => {
      const res = await devicePrompt(base, "s1", { prompt: "hi" })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe("host_scope_required")
    })
  })

  it("403s with the host-scope header when the opt-in is off (default)", async () => {
    await withServer({}, async base => {
      const res = await devicePrompt(base, "s1", { prompt: "hi" }, { [HOST_SCOPE_HEADER]: "1" })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe("spawn_disabled")
    })
  })

  it("405s on GET once the gates pass", async () => {
    await withServer({ deviceSpawnAllow: true }, async base => {
      const res = await fetch(`${base}/device-prompt/s1`, { headers: { [HOST_SCOPE_HEADER]: "1" } })
      expect(res.status).toBe(405)
    })
  })

  it("self-proxies onto the daemon's own POST /sessions/:id/prompt — an unknown session 404s from THAT route, not the gates", async () => {
    await withServer({ deviceSpawnAllow: true }, async base => {
      const res = await devicePrompt(base, "no-such-session", { prompt: "hi" }, { [HOST_SCOPE_HEADER]: "1" })
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe("send_prompt_failed")
    })
  })

  it("queues behind a busy turn exactly like a local prompt: 202 + pending + FIFO position", async () => {
    await withServer({ deviceSpawnAllow: true }, async (base, registry) => {
      const desc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: process.cwd(),
        agentSession: busyAgentSession("agent"),
        adapterSlug: "fake",
      })
      // First make the session deterministically mid-turn with a LOCAL
      // prompt (its turn generator never resolves), then the device prompt
      // must land in the FIFO behind it — never dispatched early.
      const local = await fetch(`${base}/sessions/${desc.id}/prompt?wait=false`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "start a long turn" }),
      })
      expect(local.status).toBe(202)
      await vi.waitFor(async () => {
        const desc2 = (await (await fetch(`${base}/sessions/${desc.id}`)).json()) as { busy?: boolean }
        expect(desc2.busy).toBe(true)
      })

      // (The controller's promptHostSession always sends queue:true on this
      // arm — mirrored here since this test drives the host route directly.)
      const res = await devicePrompt(base, desc.id, { prompt: "hello from the controller", queue: true }, {
        [HOST_SCOPE_HEADER]: "1",
      })
      expect(res.status).toBe(202)
      const body = (await res.json()) as { ok: boolean; pending: boolean; queuePosition: number }
      expect(body.ok).toBe(true)
      expect(body.pending).toBe(true)
      expect(body.queuePosition).toBe(1)
    })
  })
})
