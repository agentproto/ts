/**
 * `POST /sessions/:id/restart` — the failure BODY (Brief C, step 2).
 *
 * A restart that fails with a typed code goes out as
 * `{error:{code,reason,message[,action]}, message, sessionId}` at the code's
 * status, so a client can show a sentence instead of a provider's raw string.
 * The failure PATHS are covered where they run (session-restart-sandbox.test.ts);
 * the payload vocabulary itself in session-restart-typed-errors.test.ts. This
 * file is the HTTP seam: does the route actually serialize it, with the right
 * status, without losing the top-level `message` every existing reader
 * (`describeError` in the VS Code client, `formatHttpError` in the CLI) looks
 * for first?
 */

import { describe, it, expect, afterEach } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createSessionsRegistry, type AgentSessionLike, type PtyFactory } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createRuntimeEvents } from "../events.js"
import { SESSION_RESTART_REASONS } from "../session-restart-core.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

const TOKEN = "restart-payload-test-token"

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

/** The PTY override-guard test below only needs a descriptor with no
 *  `adapterSlug` — the route rejects the request before anything talks to
 *  the PTY, so a stub process is all the registry needs. */
const fakePtyFactory: PtyFactory = () => ({
  pid: 4242,
  write: () => {},
  resize: () => {},
  kill: () => {},
  onData: () => {},
  onExit: () => {},
})

function idleAgentSession(): AgentSessionLike {
  return {
    sessionId: "s",
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

async function mcpServerFactory() {
  return (await createMcpServer({ specs: [], name: "main", version: "0" })).server
}

interface Harness {
  port: number
  registry: ReturnType<typeof createSessionsRegistry>
  restart: (id: string, body: unknown) => Promise<Response>
}

let teardown: (() => Promise<void>) | undefined

afterEach(async () => {
  if (teardown) await teardown().catch(() => {})
  teardown = undefined
})

/** Boot a daemon on a free port with the route's own adapter resolver. */
async function boot(
  resolveAgentAdapter: (slug: string) => Promise<unknown>,
): Promise<Harness> {
  const port = await freePort()
  const registry = createSessionsRegistry({
    persist: false,
    sessionEvents: createSessionEventBus(),
    spawnPty: fakePtyFactory,
  })
  const http = await startHttpServer({
    port,
    token: TOKEN,
    auth: { mode: "none" },
    mcpServerFactory,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    sessions: registry,
    resolveAgentAdapter: resolveAgentAdapter as never,
    meta: { workspace: process.cwd(), registered: [] },
  })
  teardown = () => http.stop()
  const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }
  return {
    port,
    registry,
    restart: (id, body) =>
      fetch(`http://127.0.0.1:${port}/sessions/${id}/restart`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify(body ?? {}),
      }),
  }
}

interface RestartFailureBody {
  error?: { code?: string; reason?: string; message?: string; action?: unknown }
  message?: string
  sessionId?: string
}

describe("POST /sessions/:id/restart — typed failure payloads", () => {
  it("rejects an override on a PTY session as 400 `override_invalid`, with a sentence and the message", async () => {
    const { registry, restart } = await boot(async () => null)
    const pty = registry.spawnPty({
      argv: ["bash"],
      cwd: process.cwd(),
      workspaceSlug: "default",
      cols: 80,
      rows: 24,
    })

    const res = await restart(pty.id, { model: "some-model" })
    expect(res.status).toBe(400)
    const body = (await res.json()) as RestartFailureBody
    expect(body.error?.code).toBe("override_invalid")
    expect(body.error?.reason).toBe(SESSION_RESTART_REASONS.override_invalid)
    expect(body.error?.message).toMatch(/only applies to agent-cli sessions/)
    // Top-level `message` survives — the reader every existing client uses.
    expect(body.message).toBe(body.error?.message)
    expect(body.sessionId).toBe(pty.id)
  })

  it("reports a failed adapter lookup as 500 `adapter_not_found`, with its reason", async () => {
    const { registry, restart } = await boot(async () => null)
    const agent = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: idleAgentSession(),
      adapterSlug: "nope",
    })

    const res = await restart(agent.id, {})
    expect(res.status).toBe(500)
    const body = (await res.json()) as RestartFailureBody
    expect(body.error?.code).toBe("adapter_not_found")
    expect(body.error?.reason).toBe(SESSION_RESTART_REASONS.adapter_not_found)
    expect(body.error?.message).toMatch(/adapter 'nope' not found/)
    expect(body.message).toBe(body.error?.message)
    expect(body.sessionId).toBe(agent.id)
  })
})
