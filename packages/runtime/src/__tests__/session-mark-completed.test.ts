/**
 * `session_mark_completed` MCP tool — the declared steward close: verdict +
 * summary + judgedBy in one call over `registry.closeWithOutcome`, without
 * wrapup-plan classification. Pins the wiring (resolution, guard refusals,
 * endedReason and outcome stamping, flag-only verdicts) — the closeWithOutcome
 * engine itself is pinned in session-wrapup-tools.test.ts / sessions test.
 *
 * An ALREADY-terminal row is the other half of the contract: it routes to
 * `registry.resolveOutcome`, which records the same Level-2 resolution
 * WITHOUT reviving the row or rewriting its cause of death.
 */

import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import { isOutcomeCompleted } from "../session-outcome.js"
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

  it("clears keepAlive when a live session is marked completed", async () => {
    const { client, registry, close } = await buildHarness()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: idleAgentSession("acp-mc-keepalive-live"),
      adapterSlug: "claude-code",
      keepAlive: true,
    })
    expect(registry.get(desc.id)?.keepAlive).toBe(true)

    const res = await client.callTool({ name: "session_mark_completed", arguments: { sessionId: desc.id } })
    expect(JSON.parse(textOf(res))).toMatchObject({ ok: true, verdict: "done" })
    expect(registry.get(desc.id)?.keepAlive).toBeUndefined()

    await close()
    registry.shutdown()
  })

  it("clears keepAlive when an already-terminal session is marked completed", async () => {
    const { client, registry, close } = await buildHarness()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: idleAgentSession("acp-mc-keepalive-dead"),
      adapterSlug: "claude-code",
      keepAlive: true,
    })
    registry.kill(desc.id, undefined, "daemon-restart")
    expect(registry.get(desc.id)?.keepAlive).toBe(true)

    const res = await client.callTool({ name: "session_mark_completed", arguments: { sessionId: desc.id } })
    expect(JSON.parse(textOf(res))).toMatchObject({ ok: true, action: "resolved", verdict: "done" })
    expect(registry.get(desc.id)?.keepAlive).toBeUndefined()
    // The completion resolution keeps the real cause of death intact.
    expect(registry.get(desc.id)?.endedReason).toBe("daemon-restart")

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

  it("records a completion on an ALREADY-terminal session without reviving or relabelling its death", async () => {
    const { client, registry, close } = await buildHarness()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: idleAgentSession("acp-mc-5"),
      adapterSlug: "claude-code",
    })
    registry.kill(desc.id, undefined, "operator-stopped")

    const res = await client.callTool({
      name: "session_mark_completed",
      arguments: { sessionId: desc.id, note: "work was pushed before the box died" },
    })
    const parsed = JSON.parse(textOf(res)) as { ok: boolean; action?: string; verdict?: string; endedReason?: string }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((res as any).isError).toBeFalsy()
    expect(parsed).toMatchObject({ ok: true, action: "resolved", verdict: "done" })

    const after = registry.get(desc.id)
    // The resolution is recorded…
    expect(after?.outcome?.verdict).toBe("done")
    expect(after?.outcome?.source).toBe("declared")
    expect(after?.outcome?.judgedBy).toBe("steward-rules")
    expect(after?.outcome?.note).toBe("work was pushed before the box died")
    expect(after?.outcome?.termination.reason).toBe("operator-completed")
    expect(after?.outcome?.termination.previousReason).toBe("operator-stopped")
    expect(isOutcomeCompleted(after?.outcome)).toBe(true)
    // …and NOTHING about how the process actually ended changed.
    expect(after?.status).toBe("killed")
    expect(after?.endedReason).toBe("operator-stopped")
    expect(parsed.endedReason).toBe("operator-stopped")
    expect(after?.alive).toBe(false)

    await close()
    registry.shutdown()
  })

  it("records a completion on an errored (status:'error') session — the FAILED badge case", async () => {
    const { client, registry, close } = await buildHarness()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: idleAgentSession("acp-mc-6"),
      adapterSlug: "claude-code",
    })
    const row = registry.get(desc.id)!
    row.status = "error"
    row.exitCode = 1
    row.endedAt = new Date().toISOString()

    const res = await client.callTool({
      name: "session_mark_completed",
      arguments: { sessionId: desc.id, summary: "e2b cap hit after the PR merged", judgedBy: "sess_judge9" },
    })
    expect(JSON.parse(textOf(res))).toMatchObject({ ok: true, action: "resolved", verdict: "done" })

    const after = registry.get(desc.id)
    expect(after?.status).toBe("error")
    expect(after?.exitCode).toBe(1)
    expect(after?.outcome?.verdict).toBe("done")
    expect(after?.outcome?.summary).toBe("e2b cap hit after the PR merged")
    expect(after?.outcome?.judgedBy).toBe("sess_judge9")
    expect(after?.outcome?.source).toBe("judged")
    expect(isOutcomeCompleted(after?.outcome)).toBe(true)

    await close()
    registry.shutdown()
  })

  it("a non-done verdict on a terminal session only labels the outcome (no operator-completed relabel)", async () => {
    const { client, registry, close } = await buildHarness()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: idleAgentSession("acp-mc-7"),
      adapterSlug: "claude-code",
    })
    registry.kill(desc.id, undefined, "crashed")

    const res = await client.callTool({
      name: "session_mark_completed",
      arguments: { sessionId: desc.id, verdict: "partial", note: "half the plan landed" },
    })
    expect(JSON.parse(textOf(res))).toMatchObject({ ok: true, action: "resolved", verdict: "partial" })

    const after = registry.get(desc.id)
    expect(after?.outcome?.verdict).toBe("partial")
    expect(after?.outcome?.termination.reason).toBe("crashed")
    expect(isOutcomeCompleted(after?.outcome)).toBe(false)

    await close()
    registry.shutdown()
  })

  it("still refuses blocked/needs-input on a terminal session — there is no live row to wait on", async () => {
    const { client, registry, close } = await buildHarness()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: idleAgentSession("acp-mc-8"),
      adapterSlug: "claude-code",
    })
    registry.kill(desc.id, undefined, "operator-stopped")

    for (const verdict of ["blocked", "needs-input"]) {
      const res = await client.callTool({ name: "session_mark_completed", arguments: { sessionId: desc.id, verdict } })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((res as any).isError).toBe(true)
      expect(JSON.parse(textOf(res))).toMatchObject({ ok: false, error: "not_live", status: "killed", sessionId: desc.id })
    }
    // Nothing was layered: the row still carries only the Level-1 outcome the
    // exit funnel derived, with no verdict and no operator-completed relabel.
    expect(registry.get(desc.id)?.outcome?.verdict).toBeUndefined()
    expect(registry.get(desc.id)?.outcome?.termination.reason).toBe("operator-stopped")
    expect(isOutcomeCompleted(registry.get(desc.id)?.outcome)).toBe(false)

    await close()
    registry.shutdown()
  })

  it("refuses to resolve a LIVE session through the terminal path — closeWithOutcome owns it", async () => {
    const { client, registry, close } = await buildHarness()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: idleAgentSession("acp-mc-9"),
      adapterSlug: "claude-code",
    })
    expect(registry.resolveOutcome(desc.id, { verdict: "done", source: "declared" })).toBe(false)
    expect(registry.resolveOutcome("nope", { verdict: "done", source: "declared" })).toBe(false)
    expect(registry.get(desc.id)?.status).toBe("running")
    // The live path is untouched: the same call through the tool still closes it.
    const res = await client.callTool({ name: "session_mark_completed", arguments: { sessionId: desc.id } })
    expect(JSON.parse(textOf(res))).toMatchObject({ ok: true, action: "closed", endedReason: "steward-completed" })

    await close()
    registry.shutdown()
  })
})
