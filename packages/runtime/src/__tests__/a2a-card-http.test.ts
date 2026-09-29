/**
 * A2A Agent Card routes — `GET /.well-known/agent-card.json` (daemon index)
 * and `GET /a2a/apps/:appId/.well-known/agent-card.json` (one per app).
 * Real REST layer via `startHttpServer`, same pattern as app-ui-host-http.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"
import { defineApp } from "@agentproto/app-kit"
import { defineAgent } from "@agentproto/agent"
import { defineWorkflow } from "@agentproto/workflow"
import { A2A_PROTOCOL_VERSION, type AgentCard } from "@agentproto/a2a"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createAppRegistry, type AppRegistry } from "../app-registry.js"
import {
  handleA2aCardRoute,
  matchA2aCardRoute,
  type CardHandleView,
} from "../a2a-card-http.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

const APP_ID = "@test/fixture-app"

async function emitFixtureApp(dir: string): Promise<void> {
  const app = defineApp({
    id: APP_ID,
    name: "Fixture App",
    version: "2.0.0",
    description: "A fixture.",
    agents: [
      {
        agent: defineAgent({
          schema: "agent/v1",
          id: "worker",
          description: "A worker agent.",
          model: "claude-sonnet-5",
          workflows: [{ ref: "do-thing" }],
        }),
        body: "You work.",
      },
    ],
    workflows: [
      defineWorkflow({
        id: "do-thing",
        name: "Do thing",
        description: "Does a thing.",
        version: "0.1.0",
        inputs: {},
        outputs: {},
        steps: [{ id: "s1", kind: "tool", tool: "known_tool" }],
      }),
    ],
  })
  await app.emit(dir)
}

describe("A2A Agent Card HTTP routes", () => {
  let dir: string
  let appRegistry: AppRegistry

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentproto-a2a-card-"))
    await emitFixtureApp(dir)
    appRegistry = createAppRegistry()
    appRegistry.upsertApp({
      appId: APP_ID,
      dir,
      agents: [],
      workflows: [],
      unvalidatedAgentTools: [],
    })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function withServer(
    fn: (base: string) => Promise<void>,
    auth: { mode: "none" } | { mode: "bearer"; token: string } = { mode: "none" },
  ): Promise<void> {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth,
      mcpServerFactory: async () =>
        (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
      appRegistry,
    })
    try {
      await fn(`http://127.0.0.1:${port}`)
    } finally {
      await http.stop()
    }
  }

  it("serves a per-app card with the app's identity and no skills when nothing is exposed", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/a2a/apps/${encodeURIComponent(APP_ID)}/.well-known/agent-card.json`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("application/json")
      const card = (await res.json()) as AgentCard
      expect(card.protocolVersion).toBe(A2A_PROTOCOL_VERSION)
      expect(card.name).toBe("Fixture App")
      expect(card.version).toBe("2.0.0")
      expect(card.url).toBe(`${base}/a2a/apps/%40test%2Ffixture-app`)
      expect(card.capabilities).toEqual({ streaming: false, pushNotifications: false })
      expect(card.securitySchemes).toEqual({ bearer: { type: "http", scheme: "bearer" } })
      expect(card.skills).toEqual([])
    })
  })

  it("routes the literal-slash spelling of the appId too", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/a2a/apps/${APP_ID}/.well-known/agent-card.json`)
      expect(res.status).toBe(200)
      expect(((await res.json()) as AgentCard).name).toBe("Fixture App")
    })
  })

  it("404s an app that is not installed", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/a2a/apps/nope/.well-known/agent-card.json`)
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error: string }).error).toBe("app_not_found")
    })
  })

  it("serves the daemon index card with no skills when no app exposes anything", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/.well-known/agent-card.json`)
      expect(res.status).toBe(200)
      const card = (await res.json()) as AgentCard
      expect(card.url).toBe(base)
      expect(card.name).toBe("agentproto daemon")
      expect(card.skills).toEqual([])
    })
  })

  it("only answers GET", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/.well-known/agent-card.json`, { method: "POST" })
      expect(res.status).toBe(404)
    })
  })

  it("stays behind the daemon's bearer auth off loopback", async () => {
    // A forwarded request is treated as non-loopback and must present the bearer.
    await withServer(
      async base => {
        const headers = { "x-forwarded-for": "203.0.113.9" }
        const denied = await fetch(`${base}/.well-known/agent-card.json`, { headers })
        expect(denied.status).toBe(401)
        const allowed = await fetch(`${base}/.well-known/agent-card.json`, {
          headers: { ...headers, authorization: "Bearer s3cret" },
        })
        expect(allowed.status).toBe(200)
      },
      { mode: "bearer", token: "s3cret" },
    )
  })

  describe("with a handle that declares exposes", () => {
    const handle: CardHandleView = {
      id: APP_ID,
      name: "Fixture App",
      version: "2.0.0",
      exposes: { agents: ["worker"], workflows: ["do-thing"] },
      accepts: { tasks: true },
      agents: [{ agent: { id: "worker", description: "A worker agent." } }],
      workflows: [{ id: "do-thing", name: "Do thing", description: "Does a thing." }],
    }

    async function get(path: string): Promise<{ status: number; body: any }> {
      const srv = createServer((req, res) => {
        const route = matchA2aCardRoute(req.method, req.url ?? "")
        if (!route) {
          res.writeHead(404).end()
          return
        }
        void handleA2aCardRoute(req, res, route, {
          appRegistry,
          baseUrl: "http://daemon.test",
          loadHandle: async () => handle,
        })
      })
      await new Promise<void>(r => srv.listen(0, "127.0.0.1", r))
      try {
        const res = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}${path}`)
        return { status: res.status, body: await res.json() }
      } finally {
        srv.close()
      }
    }

    it("lists exposed agents and workflows as skills on the app card", async () => {
      const { status, body } = await get(`/a2a/apps/${encodeURIComponent(APP_ID)}/.well-known/agent-card.json`)
      expect(status).toBe(200)
      expect(body.url).toBe("http://daemon.test/a2a/apps/%40test%2Ffixture-app")
      expect(body.skills).toEqual([
        {
          id: "@test/fixture-app/worker",
          name: "worker",
          description: "A worker agent.",
          tags: ["agent"],
        },
        {
          id: "@test/fixture-app/do-thing",
          name: "Do thing",
          description: "Does a thing.",
          tags: ["workflow"],
        },
      ])
      expect(body.description).not.toContain("does not accept")
    })

    it("aggregates the same skills on the daemon index card", async () => {
      const { body } = await get("/.well-known/agent-card.json")
      expect(body.url).toBe("http://daemon.test")
      expect(body.skills.map((s: { id: string }) => s.id)).toEqual([
        "@test/fixture-app/worker",
        "@test/fixture-app/do-thing",
      ])
    })

    it("leaves an app whose bundle fails to load out of the index, and 500s its own card", async () => {
      const srv = createServer((req, res) => {
        const route = matchA2aCardRoute(req.method, req.url ?? "")!
        void handleA2aCardRoute(req, res, route, {
          appRegistry,
          baseUrl: "http://daemon.test",
          loadHandle: async () => {
            throw new Error("boom")
          },
        })
      })
      await new Promise<void>(r => srv.listen(0, "127.0.0.1", r))
      const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
      try {
        const index = await fetch(`${base}/.well-known/agent-card.json`)
        expect(index.status).toBe(200)
        expect(((await index.json()) as AgentCard).skills).toEqual([])
        const one = await fetch(`${base}/a2a/apps/${encodeURIComponent(APP_ID)}/.well-known/agent-card.json`)
        expect(one.status).toBe(500)
        expect(((await one.json()) as { message: string }).message).toBe("boom")
      } finally {
        srv.close()
      }
    })
  })
})

describe("matchA2aCardRoute", () => {
  it("matches only the two card routes on GET", () => {
    expect(matchA2aCardRoute("GET", "/.well-known/agent-card.json")).toEqual({ kind: "daemon" })
    expect(matchA2aCardRoute("GET", "/a2a/apps/%40a%2Fb/.well-known/agent-card.json")).toEqual({
      kind: "app",
      appId: "@a/b",
    })
    expect(matchA2aCardRoute("GET", "/a2a/apps/@a/b/.well-known/agent-card.json")).toEqual({
      kind: "app",
      appId: "@a/b",
    })
    expect(matchA2aCardRoute("POST", "/a2a/apps/x/.well-known/agent-card.json")).toBeNull()
    expect(matchA2aCardRoute("GET", "/a2a/apps/x")).toBeNull()
    expect(matchA2aCardRoute("GET", "/a2a/apps/%E0%A4%A/.well-known/agent-card.json")).toBeNull()
  })
})

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
