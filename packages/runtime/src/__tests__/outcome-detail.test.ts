/**
 * Structured outcome fields (`reason` / `question` / `errorKind` / `nextStep`
 * / `by`) on the session record — written by `closeWithOutcome`, by a manual
 * stop (`registry.kill(..., outcome)`), by the `/kill` body's `outcome`
 * (`parseStopOutcome`), and by the MCP verbs that wrap them.
 */

import { describe, expect, it } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent, SessionsRegistry } from "../sessions.js"
import { compactOutcome, parseStopOutcome, sanitizeOutcomeDetail } from "../session-outcome.js"

function idleAgentSession(id: string): AgentSessionLike {
  return {
    sessionId: id,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      await new Promise(() => {})
    },
    async cancel() {},
    async close() {},
  }
}

function spawn(reg: SessionsRegistry, id: string) {
  return reg.spawnAgent({ workspaceSlug: "default", cwd: "/tmp", agentSession: idleAgentSession(id), adapterSlug: "claude-code" })
}

describe("sanitizeOutcomeDetail / parseStopOutcome", () => {
  it("trims, caps and drops values outside the closed vocabularies", () => {
    const d = sanitizeOutcomeDetail({ reason: "  quota   hit \n", question: " ", errorKind: "nope", by: "jev", nextStep: "x".repeat(900) })
    expect(d.reason).toBe("quota hit")
    expect(d.question).toBeUndefined()
    expect(d.errorKind).toBeUndefined()
    expect(d.by).toBe("jev")
    expect(d.nextStep!.length).toBe(500)
  })

  it("parseStopOutcome rejects an unknown verdict / errorKind / by instead of dropping it", () => {
    expect(parseStopOutcome(undefined)).toEqual({ ok: true })
    expect(parseStopOutcome({ verdict: "kaput" })).toMatchObject({ ok: false })
    expect(parseStopOutcome({ errorKind: "gremlins" })).toMatchObject({ ok: false })
    expect(parseStopOutcome({ by: "nobody" })).toMatchObject({ ok: false })
    expect(parseStopOutcome("x")).toMatchObject({ ok: false })
    expect(parseStopOutcome({ verdict: "failed", reason: "r", errorKind: "quota", note: "n" })).toEqual({
      ok: true,
      outcome: { verdict: "failed", reason: "r", errorKind: "quota", note: "n" },
    })
  })

  it("compactOutcome carries verdict / reason / errorKind / by", () => {
    const c = compactOutcome({
      source: "declared",
      status: "empty",
      verdict: "failed",
      reason: "r".repeat(300),
      errorKind: "upstream",
      by: "steward-rules",
      termination: { status: "killed" },
      recordedAt: "2026-10-10T00:00:00.000Z",
    })!
    expect(c.verdict).toBe("failed")
    expect(c.reason!.length).toBe(120)
    expect(c.errorKind).toBe("upstream")
    expect(c.by).toBe("steward-rules")
  })
})

describe("registry: outcome detail on close, flag and manual stop", () => {
  it("closeWithOutcome writes the detail onto the outcome (done/failed) ", () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = spawn(reg, "acp-od-1")
    expect(
      reg.closeWithOutcome(desc.id, {
        verdict: "failed",
        source: "declared",
        judgedBy: "steward-rules",
        reason: "usage limit hit",
        errorKind: "quota",
        nextStep: "relaunch on another profile",
        by: "steward-rules",
      }),
    ).toBe(true)
    const o = reg.get(desc.id)!.outcome!
    expect(o.verdict).toBe("failed")
    expect(o).toMatchObject({ reason: "usage limit hit", errorKind: "quota", nextStep: "relaunch on another profile", by: "steward-rules" })
    reg.shutdown()
  })

  it("closeWithOutcome needs-input records question + reason on the wrapupFlag", () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = spawn(reg, "acp-od-2")
    expect(reg.closeWithOutcome(desc.id, { verdict: "needs-input", source: "declared", question: "Which region?", reason: "asked a question", by: "jev" })).toBe(true)
    const after = reg.get(desc.id)!
    expect(after.status).toBe("running")
    expect(after.wrapupFlag).toMatchObject({ verdict: "needs-input", question: "Which region?", reason: "asked a question", by: "jev" })
    reg.shutdown()
  })

  it("kill(..., outcome) on a live row stops it AND records the declared outcome (by defaults to user)", () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = spawn(reg, "acp-od-3")
    expect(reg.kill(desc.id, undefined, "operator-stopped", { verdict: "failed", reason: "wedged", errorKind: "crash", nextStep: "restart" })).toBe(true)
    const after = reg.get(desc.id)!
    expect(after.endedReason).toBe("operator-stopped")
    expect(after.outcome).toMatchObject({ source: "declared", verdict: "failed", reason: "wedged", errorKind: "crash", nextStep: "restart", by: "user" })
    expect(after.outcome!.termination.reason).toBe("operator-stopped")
    reg.shutdown()
  })

  it("kill(..., outcome) with NO reason on an ended row only labels it: no retirement, endedReason kept", () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = spawn(reg, "acp-od-4")
    reg.kill(desc.id, undefined, "idle-reaped")
    const before = reg.get(desc.id)!
    expect(before.retiredAt).toBeUndefined()
    expect(reg.kill(desc.id, undefined, undefined, { verdict: "abandoned", reason: "never mattered", by: "steward-rules" })).toBe(true)
    const after = reg.get(desc.id)!
    expect(after.endedReason).toBe("idle-reaped")
    expect(after.retiredAt).toBeUndefined()
    expect(after.outcome).toMatchObject({ verdict: "abandoned", reason: "never mattered", by: "steward-rules", source: "declared" })
    expect(after.outcome!.termination.reason).toBe("idle-reaped")
    reg.shutdown()
  })

  it("an ended row with no outcome argument and no reason stays the plain no-op", () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = spawn(reg, "acp-od-5")
    reg.kill(desc.id, undefined, "operator-stopped")
    expect(reg.kill(desc.id)).toBe(false)
    reg.shutdown()
  })

  it("kill(..., 'operator-completed', outcome) on an ended row relabels AND layers the detail", () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = spawn(reg, "acp-od-6")
    reg.kill(desc.id, undefined, "idle-reaped")
    expect(reg.kill(desc.id, undefined, "operator-completed", { verdict: "done", reason: "merged", by: "user" })).toBe(true)
    const o = reg.get(desc.id)!.outcome!
    expect(o.termination.reason).toBe("operator-completed")
    expect(o).toMatchObject({ verdict: "done", reason: "merged" })
    reg.shutdown()
  })
})

describe("MCP verbs carry the outcome detail", () => {
  async function harness() {
    const registry = createSessionsRegistry({ persist: false })
    const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
    registerSessionTools(server, {
      registry,
      workspace: process.cwd(),
      sessionWrapupJobsDir: "/tmp/outcome-detail-jobs",
      sessionWrapupApplyJobsDir: "/tmp/outcome-detail-jobs-apply",
    })
    const [c, s] = InMemoryTransport.createLinkedPair()
    await server.connect(s)
    const client = new Client({ name: "t", version: "0" })
    await client.connect(c)
    return { client, registry }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const textOf = (r: unknown): string => (r as any).content[0]?.text ?? "{}"

  it("session_mark_completed records reason / errorKind / nextStep and defaults by to user", async () => {
    const { client, registry } = await harness()
    const desc = spawn(registry, "acp-od-7")
    const res = await client.callTool({
      name: "session_mark_completed",
      arguments: { sessionId: desc.id, verdict: "failed", reason: "build kept failing", errorKind: "logic", nextStep: "fix the types" },
    })
    expect(JSON.parse(textOf(res))).toMatchObject({ ok: true, verdict: "failed", action: "closed" })
    expect(registry.get(desc.id)!.outcome).toMatchObject({ verdict: "failed", reason: "build kept failing", errorKind: "logic", nextStep: "fix the types", by: "user" })
    await client.close()
    registry.shutdown()
  })
})
