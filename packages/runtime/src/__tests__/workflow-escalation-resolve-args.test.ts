/**
 * `workflow_escalation_resolve` argument handling over a REAL MCP transport.
 *
 * Regression: the tool's input schema declared `payload` as a required
 * `z.any()`, so the approval form (`approvalId` + `approved` + `who`, which
 * has no payload) and the CLI's `agentproto workflow resolve --approve` were
 * rejected by the MCP SDK with "-32602 ... expected nonoptional, received
 * undefined at payload" before the handler ran. An absent payload now means
 * "no payload"; a run parked at a `kind: "suspend"` step that needs one gets
 * an explicit `missing_payload` error instead.
 */

import { describe, it, expect, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerOrchestrationTools } from "../orchestration-tools.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"
import type { SessionsRegistry } from "../sessions.js"
import type { WorkflowRunner } from "../workflow-runner.js"

function parseToolJson(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}

async function setup(runStatus: Record<string, unknown> = { status: "awaiting-approval" }) {
  const resolveApproval = vi.fn(() => ({ ok: true as const }))
  const resumeSuspend = vi.fn(() => ({ ok: true as const }))
  const resolve = vi.fn()
  const workflowRunner = {
    resolveApproval,
    resumeSuspend,
    resolve,
    status: vi.fn(() => runStatus),
  } as unknown as WorkflowRunner
  const registry = { get: () => undefined } as unknown as SessionsRegistry
  const server = new McpServer({ name: "resolve-args-server", version: "0.0.0" })
  registerOrchestrationTools(server, {
    registry,
    sessionEvents: createSessionEventBus(),
    eventRing: createEventRing(),
    workflowRunner,
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "resolve-args-client", version: "0.0.0" })
  await client.connect(clientTransport)
  const call = (args: Record<string, unknown>) =>
    client.callTool({ name: "workflow_escalation_resolve", arguments: args })
  return { call, resolveApproval, resumeSuspend, resolve }
}

describe("workflow_escalation_resolve arguments", () => {
  it("approval form without payload resolves the approval (the CLI --approve shape)", async () => {
    const { call, resolveApproval, resumeSuspend } = await setup()
    const result = await call({ runId: "wf_1", approved: true, who: "jeremy" })
    expect(JSON.stringify(result.content)).not.toMatch(/Input validation error/)
    expect(result.isError).not.toBe(true)
    expect(parseToolJson(result)).toMatchObject({ ok: true, runId: "wf_1" })
    expect(resolveApproval).toHaveBeenCalledWith("wf_1", { approved: true, who: "jeremy" })
    expect(resumeSuspend).not.toHaveBeenCalled()
  })

  it("approval form with approvalId and no payload (the approval card shape)", async () => {
    const { call, resolveApproval } = await setup()
    const result = await call({ runId: "wf_1", approvalId: "wfappr_1", approved: false, who: "ops" })
    expect(result.isError).not.toBe(true)
    expect(resolveApproval).toHaveBeenCalledWith("wf_1", { approvalId: "wfappr_1", approved: false, who: "ops" })
  })

  it("approval form with an explicit payload: null still resolves the approval", async () => {
    const { call, resolveApproval, resumeSuspend } = await setup()
    const result = await call({ runId: "wf_1", approvalId: "wfappr_1", approved: true, who: "ops", payload: null })
    expect(result.isError).not.toBe(true)
    expect(resolveApproval).toHaveBeenCalledOnce()
    expect(resumeSuspend).not.toHaveBeenCalled()
  })

  it("escalate form without payload reaches the escalate handler", async () => {
    const { call, resolve } = await setup({ status: "awaiting-input" })
    const result = await call({ runId: "wf_1", stageIndex: 0, stepIndex: 1, response: "yes" })
    expect(result.isError).not.toBe(true)
    expect(resolve).toHaveBeenCalledWith("wf_1", 0, 1, "yes")
  })

  it("suspend form forwards the payload", async () => {
    const { call, resumeSuspend } = await setup({ status: "awaiting-input", awaitingSuspend: { stepId: "s" } })
    const result = await call({ runId: "wf_1", payload: { tone: "formal" } })
    expect(result.isError).not.toBe(true)
    expect(resumeSuspend).toHaveBeenCalledWith("wf_1", { payload: { tone: "formal" } })
  })

  it("a run parked at a suspend step called with no payload says payload is missing", async () => {
    const { call, resumeSuspend, resolve } = await setup({ status: "awaiting-input", awaitingSuspend: { stepId: "s" } })
    const result = await call({ runId: "wf_1" })
    expect(result.isError).toBe(true)
    const body = parseToolJson(result)
    expect(body.error).toBe("missing_payload")
    expect(body.message).toMatch(/payload/)
    expect(body.message).not.toMatch(/nonoptional/)
    expect(resumeSuspend).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it("no form at all names every form, including the suspend payload", async () => {
    const { call } = await setup({ status: "running" })
    const result = await call({ runId: "wf_1" })
    expect(result.isError).toBe(true)
    const body = parseToolJson(result)
    expect(body.error).toBe("missing_fields")
    expect(body.message).toMatch(/payload/)
  })
})
