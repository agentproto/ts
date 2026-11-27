import { describe, it, expect, afterEach } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"

import { z } from "zod"
import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"
import { createApprovalsEngine } from "../approvals/engine.js"
import { registerApprovalTools } from "../approvals/tools.js"
import {
  createSessionsRegistry,
} from "../sessions.js"
import {
  MODERN_PROTOCOL_VERSION,
  createHumanGate,
  createMrtrStateStore,
  type HumanGateAuditEntry,
  type HumanGateSurfaces,
  type RunSuspendLookup,
} from "../mcp-modern/index.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

type Json = Record<string, any>

const UI_BASE = "https://console.example.test/approvals"

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

const noopConversations = (): ConversationStore => ({
  async open() {},
  async appendTurn() {},
  async read() {
    return { meta: {} as never, turns: [] }
  },
  async list() {
    return []
  },
  pathFor: (id: string) => id,
})
const noopHeartbeat = (): HeartbeatRunner => ({ start() {}, stop() {}, async fireNow() {} })

async function callTool(
  baseUrl: string,
  name: string,
  args: Json,
  opts: { id?: number; elicitation?: Json; requestState?: string; inputResponses?: Json; query?: string } = {},
) {
  const params: Json = {
    name,
    arguments: args,
    ...(opts.requestState !== undefined ? { requestState: opts.requestState } : {}),
    ...(opts.inputResponses !== undefined ? { inputResponses: opts.inputResponses } : {}),
    _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
      "io.modelcontextprotocol/clientCapabilities": { elicitation: opts.elicitation ?? { form: {}, url: {} } },
    },
  }
  const res = await fetch(`${baseUrl}/mcp${opts.query ?? ""}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
      "mcp-method": "tools/call",
      "mcp-name": name,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: opts.id ?? 1, method: "tools/call", params }),
  })
  return { status: res.status, json: (await res.json()) as Json }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

interface FakeRun {
  status: string
  awaitingSuspend?: { stepId: string; on?: string[]; reason?: string; prompt?: string; schema?: Record<string, unknown> }
}

async function startRig(opts: { surfaces?: HumanGateSurfaces; mrtrDir?: string; log?: string[] } = {}) {
  const dir = opts.mrtrDir ?? mkdtempSync(join(tmpdir(), "agentproto-mrtr-appr-"))
  const home = mkdtempSync(join(tmpdir(), "agentproto-appr-home-"))
  cleanups.push(async () => {
    rmSync(home, { recursive: true, force: true })
    if (!opts.mrtrDir) rmSync(dir, { recursive: true, force: true })
  })
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ persist: false, sessionEvents })
  const engine = createApprovalsEngine({ homeDir: home, sessionEvents, webOrigins: ["https://console.example.test"] })
  const runs = new Map<string, FakeRun>()
  const resumed: Array<{ runId: string; payload: unknown }> = []
  const runner: RunSuspendLookup = {
    status: id => runs.get(id),
    resumeSuspend: (runId, input) => {
      const run = runs.get(runId)
      if (!run?.awaitingSuspend) return { ok: false, error: "not_awaiting_suspend", message: "no" }
      resumed.push({ runId, payload: input.payload })
      run.status = "running"
      delete run.awaitingSuspend
      return { ok: true }
    },
  }
  const audits: HumanGateAuditEntry[] = []
  const surfaces = opts.surfaces ?? { approvals: true, runs: true, approvalsUiBaseUrl: UI_BASE }
  const humanGate = createHumanGate({
    sessions: registry,
    stateStore: createMrtrStateStore({ dir }),
    approvals: engine,
    workflowRunner: runner,
    surfaces: () => surfaces,
    onAudit: e => audits.push(e),
    ...(opts.log ? { log: (line: string) => opts.log!.push(line) } : {}),
  })
  const port = await freePort()
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    sessions: registry,
    mcpServerFactory: async (_deny, callerSessionId) => {
      const { server } = await createMcpServer({ specs: [], name: "approvals-e2e", version: "1.0.0" })
      registerApprovalTools(server, { engine, ...(callerSessionId ? { callerSessionId } : {}) })
      server.tool("workflow_status", "status", { runId: z.string() }, async input => ({
        content: [{ type: "text", text: JSON.stringify({ runId: input.runId, ...(runs.get(input.runId) ?? {}) }) }],
      }))
      return server
    },
    mcpModern: { enabled: true, extensions: {}, humanGate },
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    meta: { workspace: process.cwd(), registered: [] },
  })
  cleanups.push(async () => {
    await http.stop()
    registry.shutdown()
  })
  return { baseUrl: `http://127.0.0.1:${port}`, engine, runs, resumed, audits, dir }
}

const newApproval = (engine: ReturnType<typeof createApprovalsEngine>) =>
  engine.request({ kind: "send", title: "Send the weekly digest", preview: {}, payload: { to: "a" } }, { operator: true })

describe("MCP 2026-07-28 elicitation: approvals (url) and runs observed by the operator", () => {
  it("points a pending approval to the human page, and an accept decides nothing", async () => {
    const rig = await startRig()
    const rec = newApproval(rig.engine)

    const first = await callTool(rig.baseUrl, "approval_wait", { id: rec.id, timeoutMs: 0 })
    expect(first.json.result.resultType).toBe("input_required")
    const key = Object.keys(first.json.result.inputRequests)[0]!
    const req = first.json.result.inputRequests[key]
    expect(req.params.mode).toBe("url")
    expect(req.params).not.toHaveProperty("requestedSchema")
    const url = new URL(req.params.url)
    expect(`${url.origin}${url.pathname}`).toBe(UI_BASE)
    expect(url.searchParams.get("approval")).toBe(rec.id)
    expect(url.username + url.password + url.hash).toBe("")
    expect(req.params.url).not.toContain("/approvals/" + rec.id)

    const replay = await callTool(
      rig.baseUrl,
      "approval_wait",
      { id: rec.id, timeoutMs: 0 },
      { id: 2, requestState: first.json.result.requestState, inputResponses: { [key]: { action: "accept" } } },
    )
    // Still pending: a fresh url request, and the engine state is untouched.
    expect(replay.json.result.resultType).toBe("input_required")
    expect(replay.json.result.requestState).not.toBe(first.json.result.requestState)
    expect(rig.engine.get(rec.id)?.status).toBe("pending")
    expect(rig.audits.filter(a => a.kind === "approval")).toEqual([
      expect.objectContaining({ action: "accept", applied: false, detail: "display_ack" }),
    ])
  })

  it("ends the loop once a human approved, and the elicitation never consumes", async () => {
    const rig = await startRig()
    const rec = newApproval(rig.engine)
    const first = await callTool(rig.baseUrl, "approval_get", { id: rec.id })
    const key = Object.keys(first.json.result.inputRequests)[0]!
    await rig.engine.decideWeb(rec.id, "approve", { ipAddress: "127.0.0.1", userAgent: "test" })
    expect(rig.engine.get(rec.id)?.status).toBe("approved")
    const replay = await callTool(
      rig.baseUrl,
      "approval_get",
      { id: rec.id },
      { id: 2, requestState: first.json.result.requestState, inputResponses: { [key]: { action: "accept" } } },
    )
    expect(replay.json.result.resultType).not.toBe("input_required")
    expect(JSON.parse(replay.json.result.content[0].text).status).toBe("approved")
    expect(rig.engine.get(rec.id)?.consumedAt).toBeUndefined()
  })

  it("rejects a replay with other arguments, other caller, or a reused token", async () => {
    const rig = await startRig()
    const a = newApproval(rig.engine)
    const b = newApproval(rig.engine)
    const first = await callTool(rig.baseUrl, "approval_get", { id: a.id })
    const key = Object.keys(first.json.result.inputRequests)[0]!
    const token = first.json.result.requestState as string
    const responses = { [key]: { action: "accept" } }

    const otherArgs = await callTool(rig.baseUrl, "approval_get", { id: b.id }, { requestState: token, inputResponses: responses })
    expect(otherArgs.json.error?.code).toBe(-32602)
    const otherCaller = await callTool(rig.baseUrl, "approval_get", { id: a.id }, { requestState: token, inputResponses: responses, query: "?callerSessionId=sess_other" })
    expect(otherCaller.json.error?.code).toBe(-32602)

    const ok = await callTool(rig.baseUrl, "approval_get", { id: a.id }, { requestState: token, inputResponses: responses })
    expect(ok.json.result.resultType).toBe("input_required")
    const reused = await callTool(rig.baseUrl, "approval_get", { id: a.id }, { requestState: token, inputResponses: responses })
    expect(reused.json.error?.data).toEqual({ reason: "replayed" })
  })

  it("keeps today's behaviour without url capability, without a console URL, or with the approvals flag off", async () => {
    const formOnly = await startRig()
    const rec = newApproval(formOnly.engine)
    const a = await callTool(formOnly.baseUrl, "approval_get", { id: rec.id }, { elicitation: { form: {} } })
    expect(a.json.result.resultType).not.toBe("input_required")
    expect(JSON.parse(a.json.result.content[0].text).status).toBe("pending")

    const noUrl = await startRig({ surfaces: { approvals: true, runs: true } })
    const r2 = newApproval(noUrl.engine)
    const b = await callTool(noUrl.baseUrl, "approval_get", { id: r2.id })
    expect(b.json.result.resultType).not.toBe("input_required")

    const off = await startRig({ surfaces: { approvals: false, runs: true, approvalsUiBaseUrl: UI_BASE } })
    const r3 = newApproval(off.engine)
    const c = await callTool(off.baseUrl, "approval_get", { id: r3.id })
    expect(c.json.result.resultType).not.toBe("input_required")
  })

  it("refuses a console URL that could carry a credential", async () => {
    for (const base of ["https://u:p@console.example.test/a", "https://console.example.test/a#t=1", "https://console.example.test/a?token=abc", "ftp://console.example.test/a"]) {
      const rig = await startRig({ surfaces: { approvals: true, runs: true, approvalsUiBaseUrl: base } })
      const rec = newApproval(rig.engine)
      const res = await callTool(rig.baseUrl, "approval_get", { id: rec.id })
      expect(res.json.result.resultType).not.toBe("input_required")
    }
  })

  it("writes one log line with the reason, never the URL, when the configured console URL is refused", async () => {
    const log: string[] = []
    const base = "https://console.example.test/a?api_key=hunter2"
    const rig = await startRig({ surfaces: { approvals: true, runs: true, approvalsUiBaseUrl: base }, log })
    const rec = newApproval(rig.engine)
    await callTool(rig.baseUrl, "approval_get", { id: rec.id })
    await callTool(rig.baseUrl, "approval_wait", { id: rec.id, timeoutMs: 0 }, { id: 2 })
    expect(log).toHaveLength(1)
    expect(log[0]).toContain("secret_query_key")
    expect(log[0]).not.toContain("hunter2")
    expect(log[0]).not.toContain("console.example.test")

    // A form-only client can never receive the link: no log line for it.
    const formLog: string[] = []
    const formRig = await startRig({ surfaces: { approvals: true, runs: true, approvalsUiBaseUrl: base }, log: formLog })
    await callTool(formRig.baseUrl, "approval_get", { id: newApproval(formRig.engine).id }, { elicitation: { form: {} } })
    expect(formLog).toEqual([])

    // No base configured: nothing to report.
    const quiet: string[] = []
    const unset = await startRig({ surfaces: { approvals: true, runs: true }, log: quiet })
    await callTool(unset.baseUrl, "approval_get", { id: newApproval(unset.engine).id })
    expect(quiet).toEqual([])
  })

  const schema = {
    type: "object",
    properties: { choice: { type: "string", enum: ["a", "b"] }, note: { type: "string" } },
    required: ["choice"],
  }
  const parked = (): FakeRun => ({
    status: "awaiting-input",
    awaitingSuspend: { stepId: "s1", reason: "input-required", prompt: "Pick one", schema },
  })

  it("projects a parked run on the operator's workflow_status and resumes it through the resolver", async () => {
    const rig = await startRig()
    rig.runs.set("run1", parked())

    const first = await callTool(rig.baseUrl, "workflow_status", { runId: "run1" })
    expect(first.json.result.resultType).toBe("input_required")
    const key = Object.keys(first.json.result.inputRequests)[0]!
    expect(first.json.result.inputRequests[key].params.mode).toBe("form")
    expect(first.json.result.inputRequests[key].params.requestedSchema.properties.choice.enum).toEqual(["a", "b"])

    // Invalid content produces a fresh request and resumes nothing.
    const bad = await callTool(
      rig.baseUrl,
      "workflow_status",
      { runId: "run1" },
      { id: 2, requestState: first.json.result.requestState, inputResponses: { [key]: { action: "accept", content: { choice: "zzz" } } } },
    )
    expect(bad.json.result.resultType).toBe("input_required")
    expect(rig.resumed).toEqual([])

    const good = await callTool(
      rig.baseUrl,
      "workflow_status",
      { runId: "run1" },
      { id: 3, requestState: bad.json.result.requestState, inputResponses: { [key]: { action: "accept", content: { choice: "b", extra: "dropped" } } } },
    )
    expect(good.json.result.resultType).not.toBe("input_required")
    expect(rig.resumed).toEqual([{ runId: "run1", payload: { choice: "b" } }])
    expect(rig.audits.at(-1)).toEqual(expect.objectContaining({ kind: "run-input", principal: "operator", applied: true }))
  })

  it("does not resume a run on decline, and never asks the step's own session", async () => {
    const rig = await startRig()
    rig.runs.set("run2", parked())
    const first = await callTool(rig.baseUrl, "workflow_status", { runId: "run2" })
    const key = Object.keys(first.json.result.inputRequests)[0]!
    await callTool(rig.baseUrl, "workflow_status", { runId: "run2" }, { id: 2, requestState: first.json.result.requestState, inputResponses: { [key]: { action: "decline" } } })
    expect(rig.resumed).toEqual([])

    const agent = await callTool(rig.baseUrl, "workflow_status", { runId: "run2" }, { query: "?callerSessionId=sess_step" })
    expect(agent.json.result.resultType).not.toBe("input_required")
  })

  it("skips runs without a flat non-secret schema, and honours the runs flag", async () => {
    const rig = await startRig()
    rig.runs.set("secret", {
      status: "awaiting-input",
      awaitingSuspend: { stepId: "s", reason: "input-required", prompt: "Enter it", schema: { type: "object", properties: { apiKey: { type: "string" } } } },
    })
    rig.runs.set("nested", {
      status: "awaiting-input",
      awaitingSuspend: { stepId: "s", reason: "input-required", prompt: "Enter it", schema: { type: "object", properties: { o: { type: "object" } } } },
    })
    rig.runs.set("event", { status: "awaiting-input", awaitingSuspend: { stepId: "s", on: ["evt"] } })
    for (const id of ["secret", "nested", "event"]) {
      const res = await callTool(rig.baseUrl, "workflow_status", { runId: id })
      expect(res.json.result.resultType).not.toBe("input_required")
    }
    const off = await startRig({ surfaces: { approvals: true, runs: false, approvalsUiBaseUrl: UI_BASE } })
    off.runs.set("r", parked())
    const res = await callTool(off.baseUrl, "workflow_status", { runId: "r" })
    expect(res.json.result.resultType).not.toBe("input_required")
  })

  it("keeps an approval token valid across a restart (durable kind)", async () => {
    const rig1 = await startRig()
    const rec = newApproval(rig1.engine)
    const first = await callTool(rig1.baseUrl, "approval_get", { id: rec.id })
    const key = Object.keys(first.json.result.inputRequests)[0]!
    // New daemon on the same state directory; the approval is found by id on the shared engine home.
    const rig2 = await startRig({ mrtrDir: rig1.dir })
    const replay = await callTool(
      rig2.baseUrl,
      "approval_get",
      { id: rec.id },
      { requestState: first.json.result.requestState, inputResponses: { [key]: { action: "accept" } } },
    )
    expect(replay.json.error).toBeUndefined()
    expect(replay.status).toBe(200)
  })

  it("keeps a run-input token verifiable across a restart (durable kind)", async () => {
    // A token test only: the fake runner stands in for the reloaded run, this does not prove a real run resumes.
    const rig1 = await startRig()
    rig1.runs.set("run3", parked())
    const first = await callTool(rig1.baseUrl, "workflow_status", { runId: "run3" })
    expect(first.json.result.resultType).toBe("input_required")
    const key = Object.keys(first.json.result.inputRequests)[0]!

    const rig2 = await startRig({ mrtrDir: rig1.dir })
    rig2.runs.set("run3", parked())
    const replay = await callTool(
      rig2.baseUrl,
      "workflow_status",
      { runId: "run3" },
      { requestState: first.json.result.requestState, inputResponses: { [key]: { action: "accept", content: { choice: "a" } } } },
    )
    expect(replay.json.error).toBeUndefined()
    expect(rig2.resumed).toEqual([{ runId: "run3", payload: { choice: "a" } }])
  })
})
