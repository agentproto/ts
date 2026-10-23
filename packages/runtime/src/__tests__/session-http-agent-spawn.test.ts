/**
 * HTTP-level parity test for `POST /sessions/agent` (http-server.ts)
 * against the MCP `agent_start` tool (agent-tools.ts) — both now
 * delegate to the same `spawnAgentSession` (session-spawn.ts). Closes
 * the exact gap PR #158 found: the HTTP route used to silently drop
 * `orchestrator`/`mcpServers`, so a hermes/mastracode child spawned via
 * HTTP never got the mcpServers the MCP path gave it.
 */

import { describe, it, expect, vi } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"
import type { AcpMcpServer } from "@agentproto/acp"

import { startHttpServer, buildSpawnSessionHttpArgs, type AgentAdapterResolver } from "../http-server.js"
import type { SpawnAgentSessionInput } from "../session-spawn.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent, SessionDescriptor } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { encodeWhsecSecret } from "../webhook-egress/signing.js"
import { createOrchestratorInjector, createScopeTokenRegistry } from "../orchestrator-gateway.js"
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

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: "acp_http_test",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

async function mcpServerFactory() {
  return (await createMcpServer({ specs: [], name: "main", version: "0" })).server
}

describe("POST /sessions/agent — orchestrator/mcpServers parity with agent_start (MCP)", () => {
  it("orchestrator:true + caller mcpServers → descriptor carries BOTH entries", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
    })
    const sessionEvents = createSessionEventBus()
    const scopeTokens = createScopeTokenRegistry()
    const port = await freePort()
    const buildOrchestratorMcp = createOrchestratorInjector({
      scopeTokens,
      sessionEvents,
      port,
    })

    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: registry,
      resolveAgentAdapter,
      buildOrchestratorMcp,
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const callerEntry: AcpMcpServer = {
        name: "custom",
        transport: "http",
        ref: "http://example.test/mcp",
      }
      const res = await fetch(`http://127.0.0.1:${port}/sessions/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          adapter: "mock",
          cwd: "/tmp",
          orchestrator: true,
          mcpServers: [callerEntry],
        }),
      })
      expect(res.status).toBe(201)
      const desc = (await res.json()) as SessionDescriptor
      expect(desc.mcpServers).toHaveLength(2)
      expect(desc.mcpServers).toContainEqual(callerEntry)
      const orchestratorEntry = desc.mcpServers?.find(s => s.name === "agentproto")
      expect(orchestratorEntry).toBeDefined()
      expect(orchestratorEntry?.ref).toContain("/mcp/orchestrator?scope=")

      // Same shape as the MCP path: the adapter itself was started with
      // both entries merged into one mcpServers array.
      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: expect.arrayContaining([
            callerEntry,
            expect.objectContaining({ name: "agentproto" }),
          ]),
        }),
      )
    } finally {
      await http.stop()
    }
  })

  it("caller mcpServers entry with headers/credentialRef survives the HTTP body parse (regression: parseMcpServersField used to drop both)", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
    })
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
    })
    try {
      const callerEntry = {
        name: "room",
        transport: "http",
        ref: "http://example.test/mcp/room",
        headers: { Authorization: "Bearer t", "X-Probe": "y" },
        credentialRef: "/secrets/room-token",
      } satisfies AcpMcpServer
      const res = await fetch(`http://127.0.0.1:${port}/sessions/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapter: "mock", cwd: "/tmp", mcpServers: [callerEntry] }),
      })
      expect(res.status).toBe(201)
      const desc = (await res.json()) as SessionDescriptor
      // The mount must reach the spawn path with its credentials intact —
      // a parser that rebuilds only name/transport/ref silently turns a
      // credentialed mount into an anonymous one.
      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: [expect.objectContaining({
            name: "room",
            headers: { Authorization: "Bearer t", "X-Probe": "y" },
            credentialRef: "/secrets/room-token",
          })],
        }),
      )
      expect(desc.mcpServers?.[0]).toMatchObject({
        name: "room",
        headers: { Authorization: "Bearer t", "X-Probe": "y" },
        credentialRef: "/secrets/room-token",
      })
    } finally {
      await http.stop()
    }
  })

  it("caller stdio mcpServers entry keeps args/env through the HTTP body parse", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
    })
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
    })
    try {
      const callerEntry = {
        name: "browser",
        transport: "stdio",
        ref: "/usr/local/bin/chrome-devtools-mcp",
        args: ["--headless", "--isolated"],
        env: { DEBUG: "1" },
      } satisfies AcpMcpServer
      const res = await fetch(`http://127.0.0.1:${port}/sessions/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapter: "mock", cwd: "/tmp", mcpServers: [callerEntry] }),
      })
      expect(res.status).toBe(201)
      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: [expect.objectContaining({
            name: "browser",
            args: ["--headless", "--isolated"],
            env: { DEBUG: "1" },
          })],
        }),
      )
    } finally {
      await http.stop()
    }
  })

  it("buildSpawnSessionHttpArgs forwards `hooks` (agent-level clerk hook) exactly like agent_start", () => {
    const hooks = {
      clerk: {
        enabled: true,
        on: "turn_end",
        debounceMs: 30_000,
        run: {
          command: "node",
          args: ["projects/pygmalion/scripts/clerk-task-secretary.mjs", "--board", "ws:simone"],
        },
      },
    }
    expect(buildSpawnSessionHttpArgs({ hooks }, "mock").hooks).toEqual(hooks)
    // A JSON-stringified body field (form-ish callers) is tolerated too.
    expect(buildSpawnSessionHttpArgs({ hooks: JSON.stringify(hooks) }, "mock").hooks).toEqual(hooks)
    // Malformed hooks are dropped, never half-applied.
    expect(buildSpawnSessionHttpArgs({ hooks: { clerk: { on: "not-an-event" } } }, "mock")).not.toHaveProperty("hooks")
    expect(buildSpawnSessionHttpArgs({}, "mock")).not.toHaveProperty("hooks")
  })

  it("buildSpawnSessionHttpArgs forwards `browser` (true is sugar for headless; junk dropped)", () => {
    expect(buildSpawnSessionHttpArgs({ browser: "headless" }, "mock").browser).toBe("headless")
    expect(buildSpawnSessionHttpArgs({ browser: true }, "mock").browser).toBe("headless")
    expect(buildSpawnSessionHttpArgs({ browser: false }, "mock").browser).toBe(false)
    expect(buildSpawnSessionHttpArgs({ browser: "firefox" }, "mock")).not.toHaveProperty("browser")
    expect(buildSpawnSessionHttpArgs({}, "mock")).not.toHaveProperty("browser")
  })

  it("trace:true (and stringified \"true\") forwards to registry.spawnAgent; omitted stays absent", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const spawnSpy = vi.spyOn(registry, "spawnAgent")
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
    })
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
    })
    try {
      const spawn = (extra: Record<string, unknown>) =>
        fetch(`http://127.0.0.1:${port}/sessions/agent`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ adapter: "mock", cwd: "/tmp", ...extra }),
        })

      // JSON boolean true → trace:true reaches the registry.
      expect((await spawn({ trace: true })).status).toBe(201)
      expect(spawnSpy).toHaveBeenLastCalledWith(expect.objectContaining({ trace: true }))

      // Stringified "true" (form-ish caller) coerces to boolean true.
      expect((await spawn({ trace: "true" })).status).toBe(201)
      expect(spawnSpy).toHaveBeenLastCalledWith(expect.objectContaining({ trace: true }))

      // Omitted → the field is not forwarded at all (registry default applies).
      expect((await spawn({})).status).toBe(201)
      const lastArg = spawnSpy.mock.calls[spawnSpy.mock.calls.length - 1]?.[0]
      expect(lastArg).toBeDefined()
      expect("trace" in (lastArg as object)).toBe(false)
    } finally {
      await http.stop()
    }
  })

  it("POST /sessions/agent forwards hooks (the clerk hook) to the spawned session", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const spawnSpy = vi.spyOn(registry, "spawnAgent")
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
    })
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
    })
    try {
      const hooks = {
        clerk: {
          enabled: true,
          on: "turn_end",
          debounceMs: 30_000,
          run: { command: "node", args: ["secretary.mjs", "--board", "ws:simone"] },
        },
      }
      const res = await fetch(`http://127.0.0.1:${port}/sessions/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapter: "mock", cwd: "/tmp", hooks }),
      })
      expect(res.status).toBe(201)
      expect(spawnSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ clerkHook: hooks.clerk }),
      )
    } finally {
      await http.stop()
    }
  })

  it("orchestrator:true with no buildOrchestratorMcp wired → 501 not-enabled", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
    })
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
      // no buildOrchestratorMcp — daemon started without the sub-gateway.
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sessions/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapter: "mock", cwd: "/tmp", orchestrator: true }),
      })
      expect(res.status).toBe(501)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe("orchestrator_not_enabled")
      expect(startSession).not.toHaveBeenCalled()
      expect(registry.list()).toHaveLength(0)
    } finally {
      await http.stop()
    }
  })

  it("parentSessionId lineage hint (WP-R1) is honoured on the root HTTP route", async () => {
    const registry = createSessionsRegistry({ persist: false })
    // Seed a parent at depth 2 so the hint-derived child depth is observable.
    const parent = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgentSession(),
      adapterSlug: "mock",
      harness: "mock",
      depth: 2,
    })
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
    })
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
    })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sessions/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapter: "mock", cwd: "/tmp", parentSessionId: parent.id }),
      })
      expect(res.status).toBe(201)
      const desc = (await res.json()) as SessionDescriptor
      expect(desc.parentSessionId).toBe(parent.id)
      expect(desc.depth).toBe(3) // parent depth (2) + 1
    } finally {
      await http.stop()
    }
  })
})

describe("POST /sessions/agent — sandbox field forwarding", () => {
  it("sandbox body field is parsed and forwarded; no resolver → sandbox_provider_not_found", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const startSession = vi.fn(async () => ({
      sessionId: "acp_sb_test",
      // eslint-disable-next-line require-yield
      async *send(): AsyncIterable<AgentStreamEvent> { return },
      async cancel() {},
      async close() {},
    }))
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
    })
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
      // No resolveSandboxProvider — sandbox_provider_not_found expected.
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      // A string slug — simplest form.
      const res = await fetch(`http://127.0.0.1:${port}/sessions/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapter: "mock", cwd: "/tmp", sandbox: "e2b" }),
      })
      // No resolver wired → spawnAgentSession returns sandbox_provider_not_found → HTTP 500.
      expect(res.status).not.toBe(201)
      const body = (await res.json()) as { error?: string }
      expect(body.error).toBe("sandbox_provider_not_found")
      // The local adapter resolver must NOT have been consulted — sandbox
      // branch short-circuits before adapter resolution.
      expect(startSession).not.toHaveBeenCalled()
    } finally {
      await http.stop()
    }
  })

  it("forwards the WHOLE inline sandbox spec — extraPorts + env survive the mapper (regression for #1150)", () => {
    const args = buildSpawnSessionHttpArgs(
      {
        adapter: "opencode",
        cwd: "/home/user",
        sandbox: {
          provider: "e2b",
          config: { template: "tnqtmeims5q9ex7j9k06", timeoutMs: 3_600_000 },
          extraPorts: [3210],
          env: { passthrough: ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"] },
          lifecycle: { destroy_on: "workspace-close" },
        },
      },
      "opencode",
    )

    expect(typeof args.sandbox).toBe("object")
    const spec = args.sandbox as Extract<typeof args.sandbox, { provider: string }>
    // The fields the old hand-rolled mapper silently DROPPED must now survive.
    expect(spec.provider).toBe("e2b")
    expect(spec.config).toMatchObject({ template: "tnqtmeims5q9ex7j9k06", timeoutMs: 3_600_000 })
    expect(spec.extraPorts).toEqual([3210])
    expect(spec.env?.passthrough).toEqual(["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"])
    expect(spec.lifecycle?.destroy_on).toBe("workspace-close")
  })

  it("tolerates a JSON-stringified sandbox spec and still forwards extraPorts/env", () => {
    const args = buildSpawnSessionHttpArgs(
      {
        adapter: "opencode",
        sandbox: JSON.stringify({
          provider: "e2b",
          config: {},
          extraPorts: [8080, 5173],
          env: { passthrough: ["FOO"] },
        }),
      },
      "opencode",
    )
    const spec = args.sandbox as Extract<typeof args.sandbox, { provider: string }>
    expect(spec.extraPorts).toEqual([8080, 5173])
    expect(spec.env?.passthrough).toEqual(["FOO"])
  })

  it("still accepts a bare provider slug string and a minimal {provider} object", () => {
    expect(buildSpawnSessionHttpArgs({ adapter: "opencode", sandbox: "e2b" }, "opencode").sandbox).toBe("e2b")
    const minimal = buildSpawnSessionHttpArgs(
      { adapter: "opencode", sandbox: { provider: "local" } },
      "opencode",
    ).sandbox as Extract<SpawnAgentSessionInput["sandbox"], { provider: string }>
    expect(minimal.provider).toBe("local")
    expect(minimal.config).toEqual({})
  })
})

describe("POST /sessions/agent — agent_start fields the mapper used to drop", () => {
  it("commandSandbox reaches the adapter's startSession; an invalid mode is a 400, never an unconfined spawn", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const startSession = vi.fn(async (_opts: Record<string, unknown>) => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
    })
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
    })
    try {
      const spawn = (path: string, extra: Record<string, unknown>) =>
        fetch(`http://127.0.0.1:${port}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ adapter: "mock", cwd: "/tmp", ...extra }),
        })

      expect((await spawn("/sessions/agent", { commandSandbox: "workspace" })).status).toBe(201)
      expect(startSession).toHaveBeenLastCalledWith(
        expect.objectContaining({ commandSandbox: "workspace" }),
      )

      const calls = startSession.mock.calls.length
      for (const path of ["/sessions/agent", "/sessions/chat"]) {
        const res = await spawn(path, { commandSandbox: "workspce", prompt: "hi" })
        expect(res.status).toBe(400)
        expect(await res.json()).toMatchObject({ error: "invalid_command_sandbox" })
      }
      expect(startSession.mock.calls.length).toBe(calls)
    } finally {
      await http.stop()
    }
  })

  it("a malformed modelPolicy (unknown key, wrong shape) is a 400 invalid_model_policy, never an unrestricted spawn", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const startSession = vi.fn(async (_opts: Record<string, unknown>) => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
    })
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
    })
    try {
      const spawn = (path: string, modelPolicy: unknown, model?: string) =>
        fetch(`http://127.0.0.1:${port}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ adapter: "mock", cwd: "/tmp", prompt: "hi", modelPolicy, ...(model ? { model } : {}) }),
        })
      for (const path of ["/sessions/agent", "/sessions/chat"]) {
        for (const bad of [{ allows: ["zero-cost"] }, { allow: "zero-cost" }, { allow: ["a"], extra: 1 }, "nonsense"]) {
          const res = await spawn(path, bad)
          expect(res.status).toBe(400)
          expect(await res.json()).toMatchObject({ error: "invalid_model_policy" })
        }
      }
      expect(startSession).not.toHaveBeenCalled()
      // A well-formed policy the model satisfies spawns; one it does not is a
      // 400 refusal on both routes, never a 500.
      expect((await spawn("/sessions/agent", { allow: ["default-rotation"] }, "opencode/glm-5.3-flash-free")).status).toBe(201)
      for (const path of ["/sessions/agent", "/sessions/chat"]) {
        const refused = await spawn(path, { block: ["default-rotation"] }, "opencode/glm-5.3-flash-free")
        expect(refused.status).toBe(400)
        expect(await refused.json()).toMatchObject({ error: "model_policy_refused" })
      }
    } finally {
      await http.stop()
    }
  })

  it("maps commandSandbox, skills, contextContinuity, deferredTools, attach, notifyUrl and notifySecret like agent_start", () => {
    const secret = encodeWhsecSecret(Buffer.alloc(32, 0xab))
    const args = buildSpawnSessionHttpArgs(
      {
        commandSandbox: "strict",
        skills: ["agentproto", "review"],
        contextContinuity: { mode: "auto", warnAtPct: 70, hardStopAtPct: 95 },
        deferredTools: false,
        attach: { parent: "sess_parent" },
        notifyUrl: "https://example.test/hook",
        notifySecret: secret,
      },
      "claude-code",
    )
    expect(args).toMatchObject({
      commandSandbox: "strict",
      skills: ["agentproto", "review"],
      contextContinuity: { mode: "auto", warnAtPct: 70, hardStopAtPct: 95 },
      deferredTools: false,
      attach: { parent: "sess_parent" },
      notifyUrl: "https://example.test/hook",
      notifySecret: secret,
    })
  })

  it("drops a malformed notifySecret but keeps notifyUrl (fires unauthenticated, same as no secret)", () => {
    const args = buildSpawnSessionHttpArgs(
      { notifyUrl: "https://example.test/hook", notifySecret: "not-a-whsec-secret" },
      "claude-code",
    )
    expect(args.notifyUrl).toBe("https://example.test/hook")
    expect("notifySecret" in args).toBe(false)
  })

  it("tolerates JSON-stringified / string-boolean forms, as the route's other fields do", () => {
    const args = buildSpawnSessionHttpArgs(
      {
        skills: JSON.stringify(["agentproto"]),
        contextContinuity: JSON.stringify({ mode: "ask" }),
        deferredTools: "true",
        attach: "false",
      },
      "hermes",
    )
    expect(args.skills).toEqual(["agentproto"])
    expect(args.contextContinuity).toEqual({ mode: "ask" })
    expect(args.deferredTools).toBe(true)
    expect(args.attach).toBe(false)
  })

  it("drops malformed values instead of forwarding them, and never maps wait / daemon-derived fields", () => {
    const args = buildSpawnSessionHttpArgs(
      {
        skills: ["ok", 3],
        contextContinuity: { warnAtPct: 150 },
        deferredTools: "yes",
        attach: { parent: "" },
        notifyUrl: "file:///etc/passwd",
        notifySecret: "not-a-whsec-secret",
        wait: true,
        appId: "app_x",
        autoParentSessionId: "sess_forged",
      },
      "claude-code",
    )
    for (const key of [
      "skills",
      "contextContinuity",
      "deferredTools",
      "attach",
      "notifyUrl",
      "notifySecret",
      "wait",
      "appId",
      "autoParentSessionId",
    ]) {
      expect(key in args).toBe(false)
    }
  })

  it("forwards agentId / agentPath (AIP-42 manifest defaults); drops empty/absent", () => {
    expect(buildSpawnSessionHttpArgs({ agentId: "reviewer" }, "opencode").agentId).toBe("reviewer")
    expect(buildSpawnSessionHttpArgs({ agentPath: "/ws/.agents/x/AGENT.md" }, "opencode").agentPath).toBe(
      "/ws/.agents/x/AGENT.md",
    )
    expect("agentId" in buildSpawnSessionHttpArgs({ agentId: "" }, "opencode")).toBe(false)
    expect("agentPath" in buildSpawnSessionHttpArgs({}, "opencode")).toBe(false)
  })
})

describe("POST /sessions/agent — auth field (parseAuthField)", () => {
  it("keeps the mode and the box-login bridge marker on the parsed auth block", () => {
    const args = buildSpawnSessionHttpArgs({ auth: { mode: "subscription", loginFile: true } }, "codex")
    expect(args.auth).toEqual({ mode: "subscription", loginFile: true })
  })

  it("accepts a JSON-stringified auth block, like the route's other object fields", () => {
    const args = buildSpawnSessionHttpArgs(
      { auth: JSON.stringify({ mode: "subscription", loginFile: true, apiKey: "sk-test" }) },
      "codex",
    )
    expect(args.auth).toEqual({ mode: "subscription", loginFile: true, apiKey: "sk-test" })
  })

  it("drops a truthy-but-not-true loginFile — the marker is boolean-strict, never half-truthy", () => {
    const args = buildSpawnSessionHttpArgs({ auth: { mode: "subscription", loginFile: "true" } }, "codex")
    expect(args.auth).toEqual({ mode: "subscription" })
  })

  it("drops an unknown auth key instead of forwarding it across the wire", () => {
    const args = buildSpawnSessionHttpArgs(
      { auth: { mode: "api-key", apiKey: "sk-x", smuggled: 1 } },
      "claude-code",
    )
    expect(args.auth).toEqual({ mode: "api-key", apiKey: "sk-x" })
  })
})

describe("POST /sessions/agent — AIP-66 managed cloud (cloud field)", () => {
  it("buildSpawnSessionHttpArgs forwards `cloud` verbatim; junk dropped", () => {
    expect(buildSpawnSessionHttpArgs({ cloud: "anthropic" }, "claude-code-cloud").cloud).toBe(
      "anthropic",
    )
    expect(buildSpawnSessionHttpArgs({}, "mock")).not.toHaveProperty("cloud")
    expect(buildSpawnSessionHttpArgs({ cloud: "" }, "mock")).not.toHaveProperty("cloud")
    expect(buildSpawnSessionHttpArgs({ cloud: 42 }, "mock")).not.toHaveProperty("cloud")
  })

  it("cloud with NO adapter → 201 via the vendor's cloud adapter (no missing_adapter)", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const startSession = vi.fn(async (_opts: Record<string, any>) => fakeAgentSession())
    const resolveAgentAdapter = vi.fn<AgentAdapterResolver>(async () => ({
      startSession,
      commandPreview: "mock-adapter",
    }))
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
    })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sessions/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cloud: "anthropic", cwd: "/tmp", prompt: "hello cloud" }),
      })
      expect(res.status).toBe(201)
      const desc = (await res.json()) as SessionDescriptor
      expect(desc.adapterSlug).toBe("claude-code-cloud")
      expect(resolveAgentAdapter).toHaveBeenCalled()
      for (const call of resolveAgentAdapter.mock.calls) {
        expect(call[0]).toBe("claude-code-cloud")
      }
      // The relay is told where to write the learned vendor session id.
      expect(startSession.mock.calls[0]?.[0]?.env?.["AGENTPROTO_CLOUD_SESSION_META_FILE"]).toMatch(
        /cloud-session\.json$/,
      )
    } finally {
      await http.stop()
    }
  })

  it("cloud + adapter 'hermes' → 400 cloud_spawn_refused, naming the vendor's allowed harness", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolveAgentAdapter = vi.fn<AgentAdapterResolver>(async () => ({
      startSession,
      commandPreview: "mock-adapter",
    }))
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
    })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sessions/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cloud: "anthropic", adapter: "hermes", cwd: "/tmp", prompt: "hi" }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: string; message?: string }
      expect(body.error).toBe("cloud_spawn_refused")
      expect(body.message).toContain("hermes")
      expect(body.message).toContain("anthropic")
      expect(body.message).toContain("claude-code")
      // Refused before any side effect.
      expect(resolveAgentAdapter).not.toHaveBeenCalled()
      expect(startSession).not.toHaveBeenCalled()
      expect(registry.list()).toHaveLength(0)
    } finally {
      await http.stop()
    }
  })
})
