/**
 * `external` sessions — a Claude Desktop / `claude` CLI session the daemon
 * did not spawn, registered from `?callerSessionId=&host=` on an
 * authenticated `/mcp` request so it can own an AIP-46 inbox.
 *
 * Covers: registration (registry + the real HTTP gateway), liveness expiry,
 * inbox delivery to an external session, and the workflow runner posting
 * run succeeded / failed / approval items to the session that started the run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"
import type { RuntimeWorkflow } from "@agentproto/workflow-runtime"

import { registerAgentTools } from "../agent-tools.js"
import {
  createSessionsRegistry,
  SessionNotAliveError,
  DEFAULT_EXTERNAL_SESSION_LIVENESS_MS,
  type SessionsRegistry,
} from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createSessionMessage } from "../session-message.js"
import { createWorkflowRunner } from "../workflow-runner.js"
import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { isNoiseSession } from "../session-list-filters.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

function fyi(to: string, text: string) {
  return createSessionMessage({ to, from: { relation: "system" }, kind: "notice", urgency: "fyi", text })
}

describe("external session registration + liveness", () => {
  let clock: number
  let registry: SessionsRegistry
  let tmp: string
  const WINDOW = 10 * 60_000

  beforeEach(() => {
    clock = Date.parse("2026-01-01T00:00:00.000Z")
    tmp = mkdtempSync(join(tmpdir(), "external-"))
    registry = createSessionsRegistry({
      persist: false,
      transcriptDir: tmp,
      sessionEvents: createSessionEventBus(),
      externalSessionLivenessMs: WINDOW,
      externalNow: () => clock,
    })
  })
  afterEach(() => {
    registry.shutdown()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("registers an unknown id that carries a host as a running, process-less external session", () => {
    const desc = registry.touchExternal({ id: "desktop-1", host: "claude-desktop" })
    expect(desc).toMatchObject({
      id: "desktop-1",
      kind: "external",
      status: "running",
      pid: null,
      externalHost: "claude-desktop",
    })
    expect(registry.get("desktop-1")).toMatchObject({ kind: "external", status: "running" })
    expect(registry.listInbox("desktop-1")).toEqual([])
  })

  it("does not register an unknown id without a host (callers keep no_caller_identity)", async () => {
    expect(registry.touchExternal({ id: "ghost" })).toBeUndefined()
    expect(registry.get("ghost")).toBeUndefined()

    const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
    registerAgentTools(server, { registry, callerSessionId: "ghost" })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const client = new Client({ name: "t", version: "0" })
    await client.connect(ct)
    const r = (await client.callTool({ name: "inbox_list", arguments: {} })) as { content: Array<{ text: string }>; isError?: boolean }
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content[0]!.text)).toMatchObject({ error: "no_caller_identity" })
    await client.close()
  })

  it("never adopts a daemon-spawned session id", () => {
    const spawned = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: "/tmp",
      agentSession: { sessionId: "acp-x", pid: 1, async *send() { yield { kind: "turn-end", reason: "completed" } }, async cancel() {}, async close() {} },
      adapterSlug: "mock",
    })
    expect(registry.touchExternal({ id: spawned.id, host: "claude-desktop" })).toBeUndefined()
    expect(registry.get(spawned.id)?.kind).toBe("agent-cli")
  })

  it("lets an external session use inbox_list through the normal MCP tools", async () => {
    registry.touchExternal({ id: "desktop-1", host: "claude-desktop" })
    await registry.sendMessage(fyi("desktop-1", "hello from the daemon"))

    const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
    registerAgentTools(server, { registry, callerSessionId: "desktop-1" })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const client = new Client({ name: "t", version: "0" })
    await client.connect(ct)
    const r = (await client.callTool({ name: "inbox_list", arguments: {} })) as { content: Array<{ text: string }>; isError?: boolean }
    expect(r.isError).not.toBe(true)
    const body = JSON.parse(r.content[0]!.text) as { messages: Array<{ text: string }> }
    expect(body.messages.map(m => m.text)).toEqual(["hello from the daemon"])
    await client.close()
  })

  it("expires after the liveness window, and any later sighting revives it", () => {
    registry.touchExternal({ id: "desktop-1", host: "claude-desktop" })

    clock += WINDOW - 1_000
    expect(registry.get("desktop-1")?.status).toBe("running")

    // A request inside the window slides it forward.
    registry.touchExternal({ id: "desktop-1" })
    clock += WINDOW - 1_000
    expect(registry.get("desktop-1")?.status).toBe("running")

    clock += 2_000
    const expired = registry.get("desktop-1")
    expect(expired?.status).toBe("exited")
    expect(expired?.endedReason).toBeUndefined()

    // Revival: the same session shows up again (host not needed — row exists).
    registry.touchExternal({ id: "desktop-1" })
    expect(registry.get("desktop-1")?.status).toBe("running")
  })

  it("defaults the window to 30 minutes", () => {
    expect(DEFAULT_EXTERNAL_SESSION_LIVENESS_MS).toBe(30 * 60_000)
    const r2 = createSessionsRegistry({ persist: false, transcriptDir: tmp, externalNow: () => clock })
    r2.touchExternal({ id: "d", host: "claude-cli" })
    clock += 29 * 60_000
    expect(r2.get("d")?.status).toBe("running")
    clock += 2 * 60_000
    expect(r2.get("d")?.status).toBe("exited")
    r2.shutdown()
  })

  it("is not listed as an agent session and counts as noise", () => {
    registry.touchExternal({ id: "desktop-1", host: "claude-desktop" })
    expect(registry.listSummaries().summaries.map(s => s.id)).not.toContain("desktop-1")
    expect(isNoiseSession(registry.get("desktop-1")!)).toBe(true)
  })
})

describe("delivery to an external inbox", () => {
  let clock: number
  let registry: SessionsRegistry
  let tmp: string
  const WINDOW = 10 * 60_000

  beforeEach(() => {
    clock = Date.parse("2026-01-01T00:00:00.000Z")
    tmp = mkdtempSync(join(tmpdir(), "external-"))
    registry = createSessionsRegistry({
      persist: false,
      transcriptDir: tmp,
      sessionEvents: createSessionEventBus(),
      externalSessionLivenessMs: WINDOW,
      externalNow: () => clock,
    })
    registry.touchExternal({ id: "desktop-1", host: "claude-desktop" })
  })
  afterEach(() => {
    registry.shutdown()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("parks every urgency tier in the inbox — there is no turn to start or queue", async () => {
    for (const urgency of ["fyi", "next-turn", "steer"] as const) {
      const res = await registry.sendMessage(
        createSessionMessage({ to: "desktop-1", from: { relation: "system" }, kind: "notice", urgency, text: urgency }),
      )
      expect(res.delivered).toEqual({ via: "inbox" })
      expect(res.queued).toBe(false)
    }
    expect(registry.listInbox("desktop-1")!.map(m => m.text)).toEqual(["fyi", "next-turn", "steer"])
    expect(registry.get("desktop-1")?.promptQueue ?? []).toEqual([])
  })

  it("wakes a parked inbox_wait first, like any other recipient", async () => {
    const waiting = registry.waitForMessages("desktop-1", {}, { timeoutMs: 5_000 })
    await new Promise(r => setTimeout(r, 10))
    const res = await registry.sendMessage(fyi("desktop-1", "ping"))
    expect(res.delivered).toEqual({ via: "wait" })
    const got = await waiting
    expect(got.messages.map(m => m.text)).toEqual(["ping"])
  })

  it("acks delivered items", async () => {
    const res = await registry.sendMessage(fyi("desktop-1", "one"))
    expect(registry.ackInbox("desktop-1", [res.messageId])).toMatchObject({ acked: [res.messageId] })
    expect(registry.listInbox("desktop-1")).toEqual([])
  })

  it("throws session_not_alive only after liveness expiry, and a fresh sighting restores delivery", async () => {
    clock += WINDOW + 1_000
    await expect(registry.sendMessage(fyi("desktop-1", "late"))).rejects.toBeInstanceOf(SessionNotAliveError)

    registry.touchExternal({ id: "desktop-1" })
    await expect(registry.sendMessage(fyi("desktop-1", "back"))).resolves.toMatchObject({ delivered: { via: "inbox" } })
  })
})

describe("workflow caller notifications", () => {
  const inRootTmpBase = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules")
  let tmpDir: string
  let registry: SessionsRegistry
  let bus: ReturnType<typeof createSessionEventBus>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(inRootTmpBase, ".workflow-caller-test-"))
    bus = createSessionEventBus()
    registry = createSessionsRegistry({ persist: false, transcriptDir: tmpDir, sessionEvents: bus })
    registry.touchExternal({ id: "desktop-1", host: "claude-desktop" })
  })
  afterEach(() => {
    registry.shutdown()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const adapter: AgentAdapterResolver = async () => ({
    startSession: async () => ({
      sessionId: "x",
      send: async function* () {
        yield { kind: "turn-end", reason: "completed" }
      },
      cancel: async () => {},
      close: async () => {},
    }),
    commandPreview: "mock",
  })

  function writeWorkflowFile(id: string): string {
    const path = join(tmpDir, `${id}.md`)
    writeFileSync(path, `---\nname: ${id}\nid: ${id}\ndescription: test\nversion: 0.1.0\ninputs: {}\noutputs: {}\nsteps:\n  - id: signoff\n    kind: approval\n    prompt: placeholder\n    approvers:\n      - role: maintainer\n---\n`, "utf8")
    return path
  }

  function makeRunner(compile: (id: string) => RuntimeWorkflow) {
    return createWorkflowRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: adapter,
      compileWorkflow: handle => compile(handle.id),
    })
  }

  async function waitStatus(runner: ReturnType<typeof makeRunner>, runId: string, target: string): Promise<void> {
    for (let i = 0; i < 250 && runner.status(runId)?.status !== target; i++) {
      await new Promise(r => setTimeout(r, 20))
    }
    expect(runner.status(runId)?.status).toBe(target)
  }

  async function inboxOf(id: string, n: number) {
    for (let i = 0; i < 100 && (registry.listInbox(id)?.length ?? 0) < n; i++) {
      await new Promise(r => setTimeout(r, 10))
    }
    return registry.listInbox(id) ?? []
  }

  it("posts one inbox item to the caller when the run succeeds", async () => {
    const runner = makeRunner(id => ({
      id,
      steps: [{ kind: "transform", id: "t", compute: () => "ok" }],
    }))
    const run = await runner.startFromFile({ path: writeWorkflowFile("wf-ok"), callerSessionId: "desktop-1" })
    expect(run.callerSessionId).toBe("desktop-1")
    await waitStatus(runner, run.runId, "done")

    const inbox = await inboxOf("desktop-1", 1)
    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatchObject({
      kind: "notice",
      urgency: "fyi",
      from: { relation: "system" },
      correlationId: `workflow:${run.runId}`,
      data: { runId: run.runId, workflowId: "wf-ok", milestone: "succeeded" },
    })
    expect(inbox[0]!.text).toContain("succeeded")
  })

  it("posts one inbox item to the caller when the run fails, carrying the error", async () => {
    const runner = makeRunner(id => ({
      id,
      steps: [
        {
          kind: "transform",
          id: "boom",
          compute: () => {
            throw new Error("kaboom")
          },
        },
      ],
    }))
    const run = await runner.startFromFile({ path: writeWorkflowFile("wf-bad"), callerSessionId: "desktop-1" })
    await waitStatus(runner, run.runId, "failed")

    const inbox = await inboxOf("desktop-1", 1)
    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatchObject({ data: { runId: run.runId, milestone: "failed" } })
    expect(inbox[0]!.text).toContain("failed")
    expect(inbox[0]!.text).toContain("kaboom")
  })

  it("posts an inbox item when the run parks for approval, then one more when it completes", async () => {
    const runner = makeRunner(id => ({
      id,
      steps: [
        {
          kind: "approval",
          id: "signoff",
          prompt: () => "Approve the release?",
          approvers: ["maintainer"],
          onApprove: [{ kind: "transform", id: "yes", compute: () => "approved" }],
          onReject: [{ kind: "transform", id: "no", compute: () => "rejected" }],
        },
      ],
    }))
    const run = await runner.startFromFile({ path: writeWorkflowFile("wf-appr"), callerSessionId: "desktop-1" })
    await waitStatus(runner, run.runId, "awaiting-approval")

    let inbox = await inboxOf("desktop-1", 1)
    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatchObject({
      data: { runId: run.runId, milestone: "approval", stepId: "signoff" },
    })
    expect(inbox[0]!.text).toContain("Approve the release?")

    const approvalId = runner.status(run.runId)!.awaitingApproval!.approvalId
    expect(runner.resolveApproval(run.runId, { approvalId, approved: true, who: "jeremy" })).toEqual({ ok: true })
    await waitStatus(runner, run.runId, "done")
    inbox = await inboxOf("desktop-1", 2)
    expect(inbox.map(m => (m.data as { milestone: string }).milestone)).toEqual(["approval", "succeeded"])
  })

  it("notifies for workflow_start (stages) runs too, and stays silent without a caller", async () => {
    const sendMessage = vi.fn(async (_msg: { to: string }) => ({}))
    const descs = new Map<string, unknown>()
    const mockRegistry = {
      spawnAgent: vi.fn((input: { cwd?: string }) => {
        const id = `sess_${descs.size}`
        const d = { id, kind: "agent-cli", workspaceSlug: "w", command: "mock", pid: null, status: "running", startedAt: new Date().toISOString(), cwd: input.cwd }
        descs.set(id, d)
        return d
      }),
      sendPrompt: vi.fn(async (sessionId: string) => {
        setTimeout(() => bus.emit({ type: "session:turn-end", sessionId, awaitingInput: false, ts: "t" }), 5)
      }),
      get: vi.fn((id: string) => descs.get(id)),
      findByIdOrName: vi.fn((id: string) => descs.get(id)),
      kill: vi.fn(),
      forget: vi.fn(),
      sendMessage,
    } as unknown as SessionsRegistry
    const runner = createWorkflowRunner({ registry: mockRegistry, sessionEvents: bus, resolveAgentAdapter: adapter })
    const stages = [{ steps: [{ label: "s", adapter: "mock", prompt: "go" }] }]
    const settle = async (runId: string) => {
      for (let i = 0; i < 250 && !["done", "failed"].includes(runner.status(runId)?.status ?? ""); i++) {
        await new Promise(r => setTimeout(r, 20))
      }
      await new Promise(r => setTimeout(r, 20))
    }

    const quiet = await runner.start({ workflowId: "no-caller", stages })
    await settle(quiet.runId)
    expect(sendMessage).not.toHaveBeenCalled()

    const run = await runner.start({ workflowId: "with-caller", stages, callerSessionId: "desktop-1" })
    await settle(run.runId)
    expect(["done", "failed"]).toContain(runner.status(run.runId)?.status)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      to: "desktop-1",
      data: { runId: run.runId, workflowId: "with-caller" },
    })
  })

  it("a caller that has expired never breaks the run", async () => {
    let clock = Date.parse("2026-01-01T00:00:00.000Z")
    const r2 = createSessionsRegistry({
      persist: false,
      transcriptDir: tmpDir,
      sessionEvents: bus,
      externalSessionLivenessMs: 1_000,
      externalNow: () => clock,
    })
    r2.touchExternal({ id: "gone", host: "claude-desktop" })
    clock += 60_000
    const runner = createWorkflowRunner({
      registry: r2,
      sessionEvents: bus,
      resolveAgentAdapter: adapter,
      compileWorkflow: handle => ({ id: handle.id, steps: [{ kind: "transform", id: "t", compute: () => "ok" }] }),
    })
    const run = await runner.startFromFile({ path: writeWorkflowFile("wf-gone"), callerSessionId: "gone" })
    await waitStatus(runner, run.runId, "done")
    expect(r2.listInbox("gone")).toEqual([])
    r2.shutdown()
  })
})

describe("/mcp gateway registration", () => {
  const conversations: ConversationStore = {
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
  const heartbeat: HeartbeatRunner = { start() {}, stop() {}, async fireNow() {} }

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

  async function withGateway(fn: (base: string, registry: SessionsRegistry) => Promise<void>): Promise<void> {
    const tmp = mkdtempSync(join(tmpdir(), "external-http-"))
    const registry = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "t", version: "0" })).server,
      conversations,
      events: createRuntimeEvents(),
      heartbeat,
      sessions: registry,
      resolveAgentAdapter: (async () => ({ startSession: vi.fn(), commandPreview: "x" })) as unknown as AgentAdapterResolver,
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      await fn(`http://127.0.0.1:${port}`, registry)
    } finally {
      await http.stop()
      registry.shutdown()
      rmSync(tmp, { recursive: true, force: true })
    }
  }

  const initialize = (url: string, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
    })

  it("registers an unknown callerSessionId that carries ?host= on a loopback request", async () => {
    await withGateway(async (base, registry) => {
      await initialize(`${base}/mcp?callerSessionId=desktop-9&host=claude-desktop`)
      expect(registry.get("desktop-9")).toMatchObject({ kind: "external", status: "running", externalHost: "claude-desktop" })
    })
  })

  it("does not register without ?host=", async () => {
    await withGateway(async (base, registry) => {
      await initialize(`${base}/mcp?callerSessionId=desktop-9`)
      expect(registry.get("desktop-9")).toBeUndefined()
    })
  })

  it("does not honour the identity claim on a request that crossed a proxy/tunnel", async () => {
    await withGateway(async (base, registry) => {
      await initialize(`${base}/mcp?callerSessionId=desktop-9&host=claude-desktop`, { "x-forwarded-for": "203.0.113.7" })
      expect(registry.get("desktop-9")).toBeUndefined()
    })
  })

  it("rejects malformed ids and hosts", async () => {
    await withGateway(async (base, registry) => {
      await initialize(`${base}/mcp?callerSessionId=${encodeURIComponent("a b/../c")}&host=claude-desktop`)
      await initialize(`${base}/mcp?callerSessionId=desktop-9&host=${encodeURIComponent("evil host!")}`)
      expect(registry.get("a b/../c")).toBeUndefined()
      expect(registry.get("desktop-9")).toBeUndefined()
    })
  })
})
