/**
 * `/routines` REST route — PLAN.md PR B1 #2's semantic repoint.
 *
 * `GET /routines` now answers from the AIP-41 registrar's `list()`
 * (routine DEFINITIONS from `.routines/*`), not RoutineRunner runs. The
 * rest of the prefix (`POST /routines`, `GET /routines/:id`, cancel,
 * escalation/resolve) stays a thin — but now DEPRECATED (#3) — adapter
 * over RoutineRunner. Exercises the real REST layer via `startHttpServer`,
 * same pattern as user-presets-http-routes.test.ts.
 */

import { describe, expect, it } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createRoutineRunner } from "../routine-runner.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"
import type { SessionEventBus } from "../session-event-bus.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { RoutineRegistrar } from "../routine-registrar.js"

function makeMockRegistry(bus: SessionEventBus): SessionsRegistry {
  const SESSION_ID = "sess_http"
  const desc: SessionDescriptor = {
    id: SESSION_ID,
    kind: "agent-cli",
    workspaceSlug: "test",
    command: "mock",
    pid: null,
    status: "running",
    startedAt: new Date().toISOString(),
  }
  return {
    spawnAgent: () => desc,
    sendPrompt: async (sessionId: string) => {
      bus.emit({ type: "session:turn-end", sessionId, awaitingInput: false, ts: "t" })
    },
    get: (id: string) => (id === SESSION_ID ? desc : undefined),
  } as unknown as SessionsRegistry
}

function makeMockAdapter(): AgentAdapterResolver {
  return (async () => ({
    startSession: async () => ({
      sessionId: "adapter_http",
      send: async function* () {},
      cancel: async () => {},
      close: async () => {},
    }),
    commandPreview: "mock-adapter",
  })) as unknown as AgentAdapterResolver
}

function makeMockRegistrar(definitions: unknown[] = []): RoutineRegistrar {
  return {
    reconcile: () => ({ registered: [], skipped: [], removed: [], errors: [] }),
    trigger: async () => ({ ok: true, summary: "mock" }),
    list: () => definitions as ReturnType<RoutineRegistrar["list"]>,
  }
}

describe("/routines REST route", () => {
  async function withServer(
    fn: (base: string) => Promise<void>,
    opts: { withRunner?: boolean; withRegistrar?: boolean; definitions?: unknown[] } = {},
  ): Promise<void> {
    const { withRunner = true, withRegistrar = true, definitions = [] } = opts
    const port = await freePort()
    const bus = createSessionEventBus()
    const registry = makeMockRegistry(bus)
    const routineRunner = withRunner
      ? createRoutineRunner({ registry, sessionEvents: bus, resolveAgentAdapter: makeMockAdapter() })
      : undefined
    const routineRegistrar = withRegistrar ? makeMockRegistrar(definitions) : undefined

    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () =>
        (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
      ...(routineRunner ? { routineRunner } : {}),
      ...(routineRegistrar ? { routineRegistrar } : {}),
    })
    try {
      await fn(`http://127.0.0.1:${port}`)
    } finally {
      await http.stop()
    }
  }

  it("GET /routines returns registrar definitions, not RoutineRunner runs", async () => {
    const definitions = [{ id: "daily-brief", enabled: true, schedule: { kind: "cron", cron: "0 9 * * *" } }]
    await withServer(
      async base => {
        // Start a RoutineRunner run first — GET /routines must not reflect it.
        const startRes = await fetch(`${base}/routines`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ routineId: "r1", steps: [{ label: "only", adapter: "mock", prompt: "go" }] }),
        })
        expect(startRes.status).toBe(201)

        const listRes = await fetch(`${base}/routines`)
        expect(listRes.status).toBe(200)
        const body = (await listRes.json()) as { routines: unknown[] }
        expect(body.routines).toEqual(definitions)
      },
      { definitions },
    )
  })

  it("GET /routines 404s when no registrar is wired, even with a runner present", async () => {
    await withServer(
      async base => {
        const res = await fetch(`${base}/routines`)
        expect(res.status).toBe(404)
      },
      { withRegistrar: false },
    )
  })

  it("POST /routines still starts a RoutineRunner run (deprecated, kept functional)", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/routines`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ routineId: "r2", steps: [{ label: "only", adapter: "mock", prompt: "go" }] }),
      })
      expect(res.status).toBe(201)
      const run = (await res.json()) as { runId: string; status: string }
      expect(run.runId).toMatch(/^run_/)

      const getRes = await fetch(`${base}/routines/${run.runId}`)
      expect(getRes.status).toBe(200)
    })
  })
})

// ── tiny stubs (mirror user-presets-http-routes.test.ts) ──

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
