/**
 * `session_mark_completed` MCP tool — the declared steward close: verdict +
 * summary + judgedBy in one call over `registry.closeWithOutcome`, without
 * wrapup-plan classification. Pins the wiring (resolution, guard refusals,
 * endedReason and outcome stamping, flag-only verdicts) — the closeWithOutcome
 * engine itself is pinned in session-wrapup-tools.test.ts / sessions test.
 */

import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent, SessionsRegistry } from "../sessions.js"

function idleAgentSession(id: string): AgentSessionLike {
  return {
    sessionId: id,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      await new Promise(() => {}) // never resolves — keeps the session "running"
    },
    async cancel() {},
    async close() {},
  }
}

async function buildHarness(): Promise<{
  client: Client
  registry: SessionsRegistry
  close: () => Promise<void>
}> {
  const registry = createSessionsRegistry({ persist: false })
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerSessionTools(server, {
    registry,
    workspace: process.cwd(),
    sessionWrapupJobsDir: "/tmp/mark-completed-jobs",
    sessionWrapupApplyJobsDir: "/tmp/mark-completed-jobs-apply",
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)
  return { client, registry, close: () => client.close() }
}

function textOf(result: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (result as any).content[0]?.text ?? "{}"
}

describe("session_mark_completed", () => {
  it("closes a live idle session with verdict done ⇒ steward-completed + declared outcome", async () => {
    const { client, registry, close } = await buildHarness()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: idleAgentSession("acp-mc-1"),
      adapterSlug: "claude-code",
    })
    registry.get(desc.id)!.lastActivityAt = "2000-01-01T00:00:00Z"

    const res = await client.callTool({ name: "session_mark_completed", arguments: { sessionId: desc.id } })
    const parsed = JSON.parse(textOf(res)) as { ok: boolean; sessionId: string; verdict: string; endedReason?: string }
    expect(parsed).toMatchObject({ ok: true, sessionId: desc.id, verdict: "done", endedReason: "steward-completed" })
    expect(registry.get(desc.id)?.status).toBe("killed")
    expect(registry.get(desc.id)?.endedReason).toBe("steward-completed")
    expect(registry.get(desc.id)?.outcome?.verdict).toBe("done")
    expect(registry.get(desc.id)?.outcome?.source).toBe("declared")
    expect(registry.get(desc.id)?.outcome?.judgedBy).toBe("steward-rules")

    await close()
    registry.shutdown()
  })

  it("carries summary + judgedBy onto the outcome", async () => {
    const { client, registry, close } = await buildHarness()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: idleAgentSession("acp-mc-2"),
      adapterSlug: "claude-code",
    })
    registry.get(desc.id)!.lastActivityAt = "2000-01-01T00:00:00Z"

    const res = await client.callTool({
      name: "session_mark_completed",
      arguments: { sessionId: desc.id, summary: "shipped the fix", judgedBy: "sess_judge9" },
    })
    expect(JSON.parse(textOf(res)).ok).toBe(true)
    const after = registry.get(desc.id)
    expect(after?.outcome?.summary).toBe("shipped the fix")
    expect(after?.outcome?.judgedBy).toBe("sess_judge9")
    expect(after?.outcome?.source).toBe("judged")

    await close()
    registry.shutdown()
  })

  it("partial verdict closes as steward-abandoned but keeps the verdict nuance", async () => {
    const { client, registry, close } = await buildHarness()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: idleAgentSession("acp-mc-3"),
      adapterSlug: "claude-code",
    })
    registry.get(desc.id)!.lastActivityAt = "2000-01-01T00:00:00Z"

    await client.callTool({ name: "session_mark_completed", arguments: { sessionId: desc.id, verdict: "partial" } })
    const after = registry.get(desc.id)
    expect(after?.endedReason).toBe("steward-abandoned")
    expect(after?.outcome?.verdict).toBe("partial")

    await close()
    registry.shutdown()
  })

  it("blocked verdict FLAGS — session stays running, no endedReason", async () => {
    const { client, registry, close } = await buildHarness()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: idleAgentSession("acp-mc-4"),
      adapterSlug: "claude-code",
    })
    registry.get(desc.id)!.lastActivityAt = "2000-01-01T00:00:00Z"

    const res = await client.callTool({
      name: "session_mark_completed",
      arguments: { sessionId: desc.id, verdict: "blocked", note: "missing key" },
    })
    const parsed = JSON.parse(textOf(res)) as { ok: boolean; action: string }
    expect(parsed).toMatchObject({ ok: true, action: "flagged" })
    const after = registry.get(desc.id)
    expect(after?.status).toBe("running")
    expect(after?.endedReason).toBeUndefined()
    expect(after?.wrapupFlag).toMatchObject({ verdict: "blocked", note: "missing key" })

    await close()
    registry.shutdown()
  })

  it("refuses a busy session — ok:false refused_stale_or_busy, stays running", async () => {
    const { client, registry, close } = await buildHarness()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: idleAgentSession("acp-mc-4"),
      adapterSlug: "claude-code",
    })
    registry.get(desc.id)!.busy = true

    const res = await client.callTool({ name: "session_mark_completed", arguments: { sessionId: desc.id } })
    const parsed = JSON.parse(textOf(res)) as { ok: boolean; error?: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toBe("refused_stale_or_busy")
    expect(registry.get(desc.id)?.status).toBe("running")

    await close()
    registry.shutdown()
  })

  it("reports not_found for an unknown session", async () => {
    const { client, registry, close } = await buildHarness()
    const res = await client.callTool({ name: "session_mark_completed", arguments: { sessionId: "nope" } })
    expect(JSON.parse(textOf(res))).toMatchObject({ ok: false, error: "not_found", sessionId: "nope" })
    await close()
    registry.shutdown()
  })

  it("refuses an already-terminal session as not_live (distinct from busy refusals)", async () => {
    const { client, registry, close } = await buildHarness()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: idleAgentSession("acp-mc-5"),
      adapterSlug: "claude-code",
    })
    registry.kill(desc.id, undefined, "operator-stopped")

    const res = await client.callTool({ name: "session_mark_completed", arguments: { sessionId: desc.id } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((res as any).isError).toBe(true)
    expect(JSON.parse(textOf(res))).toMatchObject({ ok: false, error: "not_live", status: "killed", sessionId: desc.id })

    await close()
    registry.shutdown()
  })
})
