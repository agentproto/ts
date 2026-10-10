/**
 * `SessionDescriptor.endedReason` coverage for the reasons added alongside
 * `session-end-reason.ts`:
 *   - `isProviderLimitError` classifier (pure).
 *   - `registry.kill(id, signal, reason)` — the new optional third arg, and
 *     that omitting it preserves today's behaviour (no `endedReason`
 *     stamped).
 *   - the two operator-facing entry points that always pass a reason: the
 *     `agent_kill` MCP tool and `POST /sessions/:id/kill`.
 *   - two internal/automatic teardowns: the turn-granular `maxCostUsd` cap
 *     (`"cost-cap-exceeded"`) and a provider/subscription usage-cap error
 *     surfacing through a thrown turn error or the crash-detect sweep
 *     (`"provider-limit"`).
 *
 * `"parent-exited"` (orphan reap) is covered in orchestrator-gateway.test.ts
 * and `"policy-cleanup"` (judge-session cleanup) in supervisor-judge.test.ts
 * — both alongside the existing suites for those mechanisms rather than
 * duplicated here.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import { registerAgentTools } from "../agent-tools.js"
import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import { isProviderLimitError, isKnownSessionEndReason } from "../session-end-reason.js"

// ── isProviderLimitError / isKnownSessionEndReason (pure) ──────────────────

describe("isProviderLimitError", () => {
  it("matches Claude Code's session-limit wording", () => {
    expect(isProviderLimitError("You've hit your session limit. Try again in 5 hours.")).toBe(true)
  })

  it("matches the usage-limit variant, case-insensitively", () => {
    expect(isProviderLimitError("Looks like you HIT YOUR USAGE LIMIT for today")).toBe(true)
  })

  it("does not match an ordinary tool/turn error", () => {
    expect(isProviderLimitError("ENOENT: no such file or directory")).toBe(false)
  })

  it("does not match an unrelated mention of the word 'limit'", () => {
    expect(isProviderLimitError("rate limit exceeded on tool call, retrying")).toBe(false)
  })

  it("is false for undefined", () => {
    expect(isProviderLimitError(undefined)).toBe(false)
  })
})

describe("isKnownSessionEndReason", () => {
  it("recognizes every declared reason", () => {
    expect(isKnownSessionEndReason("operator-completed")).toBe(true)
    expect(isKnownSessionEndReason("cost-cap-exceeded")).toBe(true)
    expect(isKnownSessionEndReason("context-hard-stop")).toBe(true)
    expect(isKnownSessionEndReason("provider-limit")).toBe(true)
  })

  it("rejects an unknown / future value and undefined", () => {
    expect(isKnownSessionEndReason("some-future-reason")).toBe(false)
    expect(isKnownSessionEndReason(undefined)).toBe(false)
  })
})

// ── registry.kill(id, signal, reason) ───────────────────────────────────────

function instantAgentSession(): AgentSessionLike {
  return {
    sessionId: "instant-session",
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

describe("registry.kill — optional reason param", () => {
  it("stamps endedReason when a reason is given", () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
    })
    expect(reg.kill(desc.id, undefined, "operator-completed")).toBe(true)
    expect(reg.get(desc.id)?.endedReason).toBe("operator-completed")
    expect(reg.get(desc.id)?.status).toBe("killed")
    reg.shutdown()
  })

  it("omitting reason preserves today's behaviour — no endedReason stamped", () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
    })
    expect(reg.kill(desc.id)).toBe(true)
    expect(reg.get(desc.id)?.endedReason).toBeUndefined()
    expect(reg.get(desc.id)?.status).toBe("killed")
    reg.shutdown()
  })
})

// ── "Mark as completed" — reason:"operator-completed" on an already-ended
//    session (the UI's "mark as completed" button on a finished row) ───────

describe("kill(id, signal, 'operator-completed') on an already-terminal session", () => {
  it("relabels the persisted outcome instead of refusing, preserving the original reason as previousReason", () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: { sessionId: "s", pid: 9999, async *send() {}, async cancel() {}, async close() {} },
      adapterSlug: "claude-code",
    })
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" })
    })
    expect(reg.markCrashed(desc.id)).toBe(true)
    expect(reg.get(desc.id)?.outcome?.termination.reason).toBe("crashed")

    // The "mark as completed" call: the row is already terminal, but
    // reason:"operator-completed" is not refused like every other reason
    // would be.
    expect(reg.kill(desc.id, undefined, "operator-completed")).toBe(true)

    const after = reg.get(desc.id)
    // The raw termination mechanism is untouched — only the outcome's
    // operator-facing label changes.
    expect(after?.status).toBe("error")
    expect(after?.endedReason).toBe("crashed")
    expect(after?.outcome?.termination.reason).toBe("operator-completed")
    expect(after?.outcome?.termination.previousReason).toBe("crashed")

    killSpy.mockRestore()
    reg.shutdown()
  })

  it("is idempotent — a second 'mark as completed' call never overwrites previousReason with 'operator-completed'", () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: { sessionId: "s", pid: 9999, async *send() {}, async cancel() {}, async close() {} },
      adapterSlug: "claude-code",
    })
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" })
    })
    reg.markCrashed(desc.id)

    expect(reg.kill(desc.id, undefined, "operator-completed")).toBe(true)
    expect(reg.kill(desc.id, undefined, "operator-completed")).toBe(true)

    const after = reg.get(desc.id)
    expect(after?.outcome?.termination.reason).toBe("operator-completed")
    expect(after?.outcome?.termination.previousReason).toBe("crashed")

    killSpy.mockRestore()
    reg.shutdown()
  })

  it("a PLAIN kill (no reason) on a terminal row stays a no-op", () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
    })
    expect(reg.kill(desc.id)).toBe(true) // ordinary kill → terminal
    const before = structuredClone(reg.get(desc.id))

    expect(reg.kill(desc.id)).toBe(false)

    expect(reg.get(desc.id)).toEqual(before)
    expect(reg.get(desc.id)?.retiredAt).toBeUndefined()
    reg.shutdown()
  })

  it("reason:'operator-stopped' on an already-ended row RETIRES it (stamps retiredAt, keeps the original end reason)", () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
    })
    expect(reg.kill(desc.id, undefined, "daemon-restart")).toBe(true)
    expect(reg.get(desc.id)?.retiredAt).toBeUndefined()

    expect(reg.kill(desc.id, undefined, "operator-stopped")).toBe(true)

    const after = reg.get(desc.id)
    expect(after?.retiredAt).toEqual(expect.any(String))
    expect(after?.endedReason).toBe("daemon-restart")
    reg.shutdown()
  })

  it("reason:'operator-stopped' on an ended row with no end reason records it", () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
    })
    expect(reg.kill(desc.id)).toBe(true)
    expect(reg.kill(desc.id, undefined, "operator-stopped")).toBe(true)
    expect(reg.get(desc.id)?.endedReason).toBe("operator-stopped")
    expect(reg.get(desc.id)?.retiredAt).toEqual(expect.any(String))
    reg.shutdown()
  })
})

// ── agent_kill MCP tool — reason arg ────────────────────────────────────────

interface ToolResult {
  isError?: boolean
  content?: Array<{ type: string; text?: string }>
}

function textOf(res: ToolResult): string {
  return res.content?.find(c => c.type === "text")?.text ?? ""
}

describe("agent_kill MCP tool — reason arg", () => {
  async function connect(registry: ReturnType<typeof createSessionsRegistry>): Promise<Client> {
    const server = new McpServer({ name: "kill-reason-server", version: "0.0.0" })
    registerAgentTools(server, { registry })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "kill-reason-client", version: "0.0.0" })
    await client.connect(clientTransport)
    return client
  }

  it("reason: 'completed' → endedReason: 'operator-completed'", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
    })
    const client = await connect(registry)
    const res = (await client.callTool({
      name: "agent_kill",
      arguments: { sessionId: desc.id, reason: "completed" },
    })) as ToolResult
    expect(res.isError).toBeFalsy()
    expect(JSON.parse(textOf(res)).ok).toBe(true)
    expect(registry.get(desc.id)?.endedReason).toBe("operator-completed")
    registry.shutdown()
  })

  it("reason omitted → defaults to endedReason: 'operator-stopped'", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
    })
    const client = await connect(registry)
    const res = (await client.callTool({
      name: "agent_kill",
      arguments: { sessionId: desc.id },
    })) as ToolResult
    expect(res.isError).toBeFalsy()
    expect(registry.get(desc.id)?.endedReason).toBe("operator-stopped")
    registry.shutdown()
  })
})

// ── POST /sessions/:id/kill — reason body ───────────────────────────────────

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

describe("POST /sessions/:id/kill — reason body", () => {
  let stopServer: (() => Promise<void>) | undefined

  afterEach(async () => {
    await stopServer?.()
    stopServer = undefined
  })

  async function withServer(
    run: (port: number, registry: ReturnType<typeof createSessionsRegistry>) => Promise<void>,
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
    })
    stopServer = () => http.stop()
    try {
      await run(port, registry)
    } finally {
      await http.stop()
      stopServer = undefined
    }
  }

  it("{ reason: 'stopped' } → endedReason: 'operator-stopped'", async () => {
    await withServer(async (port, registry) => {
      const desc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: instantAgentSession(),
        adapterSlug: "fake",
      })
      const res = await fetch(`http://127.0.0.1:${port}/sessions/${desc.id}/kill`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "stopped" }),
      })
      expect(res.status).toBe(200)
      expect(registry.get(desc.id)?.endedReason).toBe("operator-stopped")
    })
  })

  it("{ reason: 'completed' } → endedReason: 'operator-completed'", async () => {
    await withServer(async (port, registry) => {
      const desc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: instantAgentSession(),
        adapterSlug: "fake",
      })
      const res = await fetch(`http://127.0.0.1:${port}/sessions/${desc.id}/kill`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "completed" }),
      })
      expect(res.status).toBe(200)
      expect(registry.get(desc.id)?.endedReason).toBe("operator-completed")
    })
  })

  it("no body → still tagged endedReason: 'operator-stopped' (today's response shape is unchanged)", async () => {
    await withServer(async (port, registry) => {
      const desc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: instantAgentSession(),
        adapterSlug: "fake",
      })
      const res = await fetch(`http://127.0.0.1:${port}/sessions/${desc.id}/kill`, { method: "POST" })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; sessionId: string }
      expect(body).toEqual({ ok: true, sessionId: desc.id })
      expect(registry.get(desc.id)?.endedReason).toBe("operator-stopped")
    })
  })

  it("{ reason: 'completed' } on an ALREADY-ENDED session — 200, outcome relabeled ('mark as completed')", async () => {
    await withServer(async (port, registry) => {
      const desc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: instantAgentSession(),
        adapterSlug: "fake",
      })
      // End it first, with no operator reason — a plain automatic-looking
      // kill, so there's a real "before" state to relabel.
      expect(registry.kill(desc.id)).toBe(true)
      expect(registry.get(desc.id)?.status).toBe("killed")

      const res = await fetch(`http://127.0.0.1:${port}/sessions/${desc.id}/kill`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "completed" }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; sessionId: string }
      expect(body.ok).toBe(true)
      expect(registry.get(desc.id)?.outcome?.termination.reason).toBe("operator-completed")
    })
  })

  it("{ reason: 'stopped' } on an ALREADY-ENDED session retires it (200, retiredAt stamped)", async () => {
    await withServer(async (port, registry) => {
      const desc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: instantAgentSession(),
        adapterSlug: "fake",
      })
      expect(registry.kill(desc.id)).toBe(true)

      const res = await fetch(`http://127.0.0.1:${port}/sessions/${desc.id}/kill`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "stopped" }),
      })
      expect(res.status).toBe(200)
      expect(registry.get(desc.id)?.retiredAt).toEqual(expect.any(String))
    })
  })
})

describe("POST /sessions/:id/kill — outcome body", () => {
  let stopServer: (() => Promise<void>) | undefined
  afterEach(async () => {
    await stopServer?.()
    stopServer = undefined
  })

  async function withServer(run: (port: number, registry: ReturnType<typeof createSessionsRegistry>) => Promise<void>): Promise<void> {
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
    })
    stopServer = () => http.stop()
    try {
      await run(port, registry)
    } finally {
      await http.stop()
      stopServer = undefined
    }
  }
  const post = (port: number, id: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}/sessions/${id}/kill`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

  it("{ outcome } on a live row stops it and records verdict + detail (failed ⇒ operator-stopped)", async () => {
    await withServer(async (port, registry) => {
      const desc = registry.spawnAgent({ workspaceSlug: "default", cwd: "/tmp", agentSession: instantAgentSession(), adapterSlug: "fake" })
      const res = await post(port, desc.id, { outcome: { verdict: "failed", reason: "wedged", errorKind: "crash", nextStep: "restart it" } })
      expect(res.status).toBe(200)
      const after = registry.get(desc.id)!
      expect(after.endedReason).toBe("operator-stopped")
      expect(after.outcome).toMatchObject({ verdict: "failed", reason: "wedged", errorKind: "crash", nextStep: "restart it", by: "user", source: "declared" })
    })
  })

  it("{ outcome: done } with no reason reads as operator-completed", async () => {
    await withServer(async (port, registry) => {
      const desc = registry.spawnAgent({ workspaceSlug: "default", cwd: "/tmp", agentSession: instantAgentSession(), adapterSlug: "fake" })
      expect((await post(port, desc.id, { outcome: { verdict: "done", reason: "shipped" } })).status).toBe(200)
      expect(registry.get(desc.id)?.endedReason).toBe("operator-completed")
    })
  })

  it("{ outcome } alone on an ALREADY-ENDED row labels it without retiring it", async () => {
    await withServer(async (port, registry) => {
      const desc = registry.spawnAgent({ workspaceSlug: "default", cwd: "/tmp", agentSession: instantAgentSession(), adapterSlug: "fake" })
      expect(registry.kill(desc.id)).toBe(true)
      expect((await post(port, desc.id, { outcome: { verdict: "abandoned", reason: "obsolete" } })).status).toBe(200)
      const after = registry.get(desc.id)!
      expect(after.retiredAt).toBeUndefined()
      expect(after.outcome).toMatchObject({ verdict: "abandoned", reason: "obsolete" })
    })
  })

  it("an invalid outcome is a 400 and the session is left alone", async () => {
    await withServer(async (port, registry) => {
      const desc = registry.spawnAgent({ workspaceSlug: "default", cwd: "/tmp", agentSession: instantAgentSession(), adapterSlug: "fake" })
      const res = await post(port, desc.id, { outcome: { verdict: "kaput" } })
      expect(res.status).toBe(400)
      expect(registry.get(desc.id)?.status).toBe("running")
    })
  })
})

describe("POST /sessions/:id/prompt — superseded session", () => {
  let stopServer: (() => Promise<void>) | undefined
  afterEach(async () => {
    await stopServer?.()
    stopServer = undefined
  })

  it("a human prompt to a continuedTo row is refused with 409 session_not_alive + reason superseded naming the successor", async () => {
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
    })
    stopServer = () => http.stop()
    const spawn = () =>
      registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: instantAgentSession(),
        adapterSlug: "fake",
      })
    const oldRow = spawn()
    const successor = spawn()
    registry.kill(oldRow.id)
    registry.markRetired(oldRow.id, { continuedTo: successor.id, cause: "continued" })

    for (const suffix of ["", "?wait=false"]) {
      const res = await fetch(`http://127.0.0.1:${port}/sessions/${oldRow.id}/prompt${suffix}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "hello" }),
      })
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error: string; reason: string; continuedTo: string }
      expect(body.error).toBe("session_not_alive")
      expect(body.reason).toBe("superseded")
      expect(body.continuedTo).toBe(successor.id)
    }
    expect(registry.get(oldRow.id)?.status).toBe("killed")
  })
})

// ── Cost-cap kill → endedReason: "cost-cap-exceeded" ───────────────────────

function overBudgetAgentSession(): AgentSessionLike {
  return {
    sessionId: "over-budget",
    async *send(): AsyncIterable<AgentStreamEvent> {
      yield { kind: "usage_update", size: 1000, used: 10, cost: { amount: 5, currency: "USD" } }
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

describe("turn-granular maxCostUsd cap", () => {
  it("kills the session and tags endedReason: 'cost-cap-exceeded' once cost exceeds the cap", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: overBudgetAgentSession(),
      adapterSlug: "fake",
      maxCostUsd: 1,
    })
    await reg.sendPrompt(desc.id, "go")
    const after = reg.get(desc.id)
    expect(after?.status).toBe("killed")
    expect(after?.endedReason).toBe("cost-cap-exceeded")
    reg.shutdown()
  })
})

// ── Provider/subscription usage-cap error classification ───────────────────

describe("provider-limit classification", () => {
  it("a thrown usage-cap error is tagged endedReason: 'provider-limit' (not the bare 'turn error')", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const fakeAgent: AgentSessionLike = {
      sessionId: "acp-limit-throws",
      // eslint-disable-next-line require-yield
      async *send(): AsyncGenerator<never> {
        throw new Error("You've hit your session limit. Try again in 3 hours.")
      },
      async cancel() {},
      async close() {},
    }
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent,
      adapterSlug: "fake",
    })
    await reg.sendPrompt(desc.id, "go")
    const after = reg.get(desc.id)
    expect(after?.status).toBe("error")
    expect(after?.endedReason).toBe("provider-limit")
    expect(after?.lastError).toContain("hit your session limit")
    reg.shutdown()
  })

  it("an ordinary thrown error is NOT tagged provider-limit (regression guard)", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const fakeAgent: AgentSessionLike = {
      sessionId: "acp-ordinary-throws",
      // eslint-disable-next-line require-yield
      async *send(): AsyncGenerator<never> {
        throw new Error("subprocess exited with ENOBUFS")
      },
      async cancel() {},
      async close() {},
    }
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent,
      adapterSlug: "fake",
    })
    await reg.sendPrompt(desc.id, "go")
    const after = reg.get(desc.id)
    expect(after?.status).toBe("error")
    expect(after?.endedReason).toBeUndefined()
    expect(after?.lastError).toBeUndefined()
    reg.shutdown()
  })

  describe("markCrashed", () => {
    let tmp: string
    let killSpy: { mockRestore: () => void } | null = null

    afterEach(() => {
      killSpy?.mockRestore()
      killSpy = null
      if (tmp) rmSync(tmp, { recursive: true, force: true })
    })

    it("a session whose last error was a usage-cap message crashes as 'provider-limit', not 'crashed'", async () => {
      tmp = mkdtempSync(join(tmpdir(), "provider-limit-crash-"))
      const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
      let sawError = false
      const fakeAgent: AgentSessionLike = {
        sessionId: "acp-limit-then-gone",
        pid: 4242,
        async *send(): AsyncIterable<AgentStreamEvent> {
          yield {
            kind: "error",
            error: { message: "You've hit your usage limit for this plan." },
          }
          sawError = true
        },
        async cancel() {},
        async close() {},
      }
      const desc = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: fakeAgent,
        adapterSlug: "claude-code",
      })
      await reg.sendPrompt(desc.id, "go")
      expect(sawError).toBe(true)

      // Fake the OS reporting the pid gone, same technique as
      // crash-reaper.test.ts's markCrashed suite.
      killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" })
      })
      expect(reg.get(desc.id)?.processAlive).toBe(false)

      expect(reg.markCrashed(desc.id)).toBe(true)
      const after = reg.get(desc.id)!
      expect(after.status).toBe("error")
      expect(after.endedReason).toBe("provider-limit")
      expect(after.lastError).toContain("hit your usage limit")
      reg.shutdown()
    })

    it("a session with no usage-cap error still crashes as 'crashed' (regression guard)", async () => {
      tmp = mkdtempSync(join(tmpdir(), "ordinary-crash-"))
      const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
      const fakeAgent: AgentSessionLike = {
        sessionId: "acp-ordinary-gone",
        pid: 4343,
        async *send(): AsyncIterable<AgentStreamEvent> {
          yield { kind: "turn-end", reason: "completed" }
        },
        async cancel() {},
        async close() {},
      }
      const desc = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: fakeAgent,
        adapterSlug: "claude-code",
      })
      await reg.sendPrompt(desc.id, "go")

      killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" })
      })
      expect(reg.get(desc.id)?.processAlive).toBe(false)

      expect(reg.markCrashed(desc.id)).toBe(true)
      const after = reg.get(desc.id)!
      expect(after.status).toBe("error")
      expect(after.endedReason).toBe("crashed")
      expect(after.lastError).toContain("session crashed")
      reg.shutdown()
    })
  })
})

describe("usage-limit wallet naming", () => {
  it("classifies opencode's `Go usage limit exceeded` as a provider limit", async () => {
    const { isProviderLimitError } = await import("../session-end-reason.js")
    expect(isProviderLimitError("AI_APICallError: Go usage limit exceeded")).toBe(true)
    expect(isProviderLimitError("rate limit reached for tool")).toBe(false)
  })

  it("tags a usage-limit error with the profile (and label) that was billed, once", async () => {
    const { tagLimitErrorWithWallet } = await import("../session-end-reason.js")
    const tagged = tagLimitErrorWithWallet("Go usage limit exceeded", {
      profileRef: "opencode-ws01",
      label: "opencode console: Ws01",
    })
    expect(tagged).toBe(
      'Go usage limit exceeded [wallet: profile "opencode-ws01" — opencode console: Ws01]',
    )
    expect(tagLimitErrorWithWallet(tagged, { profileRef: "other" })).toBe(tagged)
  })

  it("names the pinned sub-account (display name preferred, else id)", async () => {
    const { tagLimitErrorWithWallet } = await import("../session-end-reason.js")
    expect(
      tagLimitErrorWithWallet("usage limit exceeded", {
        profileRef: "p",
        subaccount: { kind: "org", id: "org_1", name: "Ws01" },
      }),
    ).toBe('usage limit exceeded [wallet: profile "p", org "Ws01"]')
    expect(
      tagLimitErrorWithWallet("usage limit exceeded", {
        profileRef: "p",
        label: "L",
        subaccount: { kind: "project", id: "proj_9" },
      }),
    ).toBe('usage limit exceeded [wallet: profile "p" — L, project "proj_9"]')
  })

  it("leaves other errors and profile-less sessions untouched", async () => {
    const { tagLimitErrorWithWallet } = await import("../session-end-reason.js")
    expect(tagLimitErrorWithWallet("boom", { profileRef: "p" })).toBe("boom")
    expect(tagLimitErrorWithWallet("Go usage limit exceeded", undefined)).toBe("Go usage limit exceeded")
  })
})
