import { afterEach, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerAgentTools } from "../agent-tools.js"
import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"
import { registerOrchestrationTools } from "../orchestration-tools.js"
import { createSessionsRegistry, type AgentSessionLike, type SessionsRegistry } from "../sessions.js"
import {
  MODERN_PROTOCOL_VERSION,
  TASKS_EXTENSION,
  createHumanGate,
  createMrtrStateStore,
  createTaskProjector,
  createTurnTaskLedger,
} from "../mcp-modern/index.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

type Json = Record<string, any>

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

/** A fake agent whose turns end only when the test releases them (or when `cancel()` interrupts the running one). */
function controllableAgent() {
  const releases: Array<(reason: string) => void> = []
  let turn = 0
  const agent: AgentSessionLike = {
    sessionId: "controllable",
    async *send() {
      const n = ++turn
      const reason = await new Promise<string>(resolve => {
        releases[n - 1] = resolve
      })
      yield { kind: "text-delta", text: `answer of turn ${n}` }
      yield { kind: "turn-end", reason }
    },
    async cancel() {
      releases[turn - 1]?.("cancelled")
    },
    async close() {
      releases[turn - 1]?.("cancelled")
    },
  }
  return {
    agent,
    finish: (n: number) => releases[n - 1]?.("completed"),
  }
}

/** A fake agent that parks a permission request mid-turn (permissionHold sessions). */
function parkingAgent() {
  const responded: Array<{ requestId: string; resolution: unknown }> = []
  let release: (() => void) | null = null
  const agent: AgentSessionLike = {
    sessionId: "parking",
    pid: 4242,
    async *send() {
      yield {
        kind: "agent-prompt",
        toolCallId: "perm-task",
        toolName: "Write",
        text: 'Allow "Write"?',
        options: [
          { optionId: "opt-once", name: "Allow once", kind: "allow_once" },
          { optionId: "opt-reject", name: "Reject", kind: "reject_once" },
        ],
      }
      await new Promise<void>(r => {
        release = r
      })
      yield { kind: "text-delta", text: "wrote it" }
      yield { kind: "turn-end", reason: "completed" }
    },
    respondPermission(id, resolution) {
      responded.push({ requestId: id, resolution })
      release?.()
      return true
    },
    async cancel() {},
    async close() {
      release?.()
    },
  }
  return { agent, responded }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function startRig(opts: { tasks?: boolean; dir?: string } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "agentproto-mcp-tasks-e2e-"))
  if (!opts.dir) cleanups.push(async () => rmSync(dir, { recursive: true, force: true }))
  const sessionEvents = createSessionEventBus()
  const eventRing = createEventRing()
  const registry: SessionsRegistry = createSessionsRegistry({ persist: false, sessionEvents })
  const humanGate = createHumanGate({
    sessions: registry,
    stateStore: createMrtrStateStore({ dir: join(dir, "mrtr") }),
  })
  const projector = createTaskProjector({
    sessions: registry,
    ledger: createTurnTaskLedger({ dir: join(dir, "tasks") }),
    humanGate,
  })
  sessionEvents.on("session:turn-end", ev => projector.observeTurnEnd(ev.sessionId, ev.reason))

  const port = await freePort()
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    sessions: registry,
    mcpServerFactory: async (_deny, callerSessionId) => {
      const { server } = await createMcpServer({ specs: [], name: "tasks-e2e", version: "1.0.0" })
      registerAgentTools(server, { registry, ...(callerSessionId ? { callerSessionId } : {}) })
      registerOrchestrationTools(server, {
        registry,
        sessionEvents,
        eventRing,
        ...(callerSessionId ? { callerSessionId } : {}),
      })
      return server
    },
    mcpModern: {
      enabled: true,
      extensions: {},
      humanGate,
      ...(opts.tasks === false ? {} : { tasks: projector }),
    },
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    meta: { workspace: process.cwd(), registered: [] },
  })
  cleanups.push(async () => {
    await http.stop()
    registry.shutdown()
  })
  return { baseUrl: `http://127.0.0.1:${port}`, registry, dir }
}

interface CallOpts {
  declare?: boolean
  elicitation?: boolean
  query?: string
  nameHeader?: string
  id?: number
}

async function rpc(baseUrl: string, method: string, params: Json, name: string | undefined, opts: CallOpts = {}) {
  const capabilities: Json = {
    ...(opts.declare === false ? {} : { extensions: { [TASKS_EXTENSION]: {} } }),
    ...(opts.elicitation ? { elicitation: { form: {} } } : {}),
  }
  const res = await fetch(`${baseUrl}/mcp${opts.query ?? ""}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
      "mcp-method": method,
      ...(name !== undefined ? { "mcp-name": opts.nameHeader ?? name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: opts.id ?? 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": capabilities,
        },
      },
    }),
  })
  return { status: res.status, json: (await res.json()) as Json }
}

const prompt = (baseUrl: string, sessionId: string, text: string, opts: CallOpts & { args?: Json } = {}) =>
  rpc(baseUrl, "tools/call", { name: "agent_prompt", arguments: { sessionId, prompt: text, ...(opts.args ?? {}) } }, "agent_prompt", opts)
const getTask = (baseUrl: string, taskId: string, opts: CallOpts = {}) =>
  rpc(baseUrl, "tasks/get", { taskId }, taskId, opts)

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms
  while (!check() && Date.now() < until) await new Promise(r => setTimeout(r, 5))
  expect(check()).toBe(true)
}

function spawnControllable(registry: SessionsRegistry, extra: Record<string, unknown> = {}) {
  const fake = controllableAgent()
  const desc = registry.spawnAgent({
    workspaceSlug: "default",
    cwd: process.cwd(),
    agentSession: fake.agent,
    adapterSlug: "fake",
    ...extra,
  })
  return { ...fake, id: desc.id }
}

describe("MCP Tasks extension e2e over /mcp (one turn = one task)", () => {
  it("announces the extension in server/discover only when it is enabled", async () => {
    const on = await startRig()
    const off = await startRig({ tasks: false })
    const discover = (baseUrl: string) =>
      rpc(baseUrl, "server/discover", {}, undefined, { declare: false }).then(r => r.json.result.capabilities.extensions)
    expect((await discover(on.baseUrl))[TASKS_EXTENSION]).toEqual({})
    expect((await discover(off.baseUrl) ?? {})[TASKS_EXTENSION]).toBeUndefined()
  })

  it("agent_prompt answers a CreateTaskResult, tasks/get follows the turn, and the session outlives the task", async () => {
    const rig = await startRig()
    const s = spawnControllable(rig.registry)

    const created = await prompt(rig.baseUrl, s.id, "first")
    expect(created.status).toBe(200)
    const r = created.json.result
    expect(r.resultType).toBe("task")
    expect(r.taskId).toMatch(/^task_[0-9a-f]{32}$/)
    expect(r.taskId).not.toContain(s.id)
    expect(r.status).toBe("working")
    expect(typeof r.ttlMs).toBe("number")
    expect(typeof r.pollIntervalMs).toBe("number")

    const working = await getTask(rig.baseUrl, r.taskId)
    expect(working.json.result.resultType).toBe("complete")
    expect(working.json.result.status).toBe("working")
    expect(working.json.result).not.toHaveProperty("cacheScope")

    await waitFor(() => rig.registry.get(s.id)?.busy === true)
    s.finish(1)
    await waitFor(() => (rig.registry.get(s.id)?.turnsCompleted ?? 0) >= 1)

    const done = await getTask(rig.baseUrl, r.taskId)
    expect(done.json.result.status).toBe("completed")
    expect(done.json.result.result.content[0].text).toContain("answer of turn 1")
    expect(done.json.result.result.structuredContent.sessionId).toBe(s.id)
    expect(rig.registry.get(s.id)?.status).toBe("running")

    // a second prompt is a NEW task, the first one stays as recorded
    const second = await prompt(rig.baseUrl, s.id, "second")
    expect(second.json.result.taskId).not.toBe(r.taskId)
    await waitFor(() => rig.registry.get(s.id)?.busy === true)
    s.finish(2)
    await waitFor(() => (rig.registry.get(s.id)?.turnsCompleted ?? 0) >= 2)
    const first = await getTask(rig.baseUrl, r.taskId)
    expect(first.json.result.result.content[0].text).toContain("answer of turn 1")
    const secondDone = await getTask(rig.baseUrl, second.json.result.taskId)
    expect(secondDone.json.result.status).toBe("completed")
    expect(secondDone.json.result.result.content[0].text).toContain("answer of turn 2")
  })

  it("a client that did not declare the extension gets the ordinary result, and -32021 (HTTP 400) on tasks/*", async () => {
    const rig = await startRig()
    const s = spawnControllable(rig.registry)
    const plain = await prompt(rig.baseUrl, s.id, "hello", { declare: false })
    expect(plain.json.result.resultType).toBe("complete")
    expect(JSON.parse(plain.json.result.content[0].text).sessionId).toBe(s.id)

    const refused = await getTask(rig.baseUrl, `task_${"1".repeat(32)}`, { declare: false })
    expect(refused.status).toBe(400)
    expect(refused.json.error.code).toBe(-32021)
    expect(refused.json.error.data.requiredCapabilities.extensions[TASKS_EXTENSION]).toEqual({})
  })

  it("flag off: tasks/* are unknown, agent_prompt answers as before", async () => {
    const rig = await startRig({ tasks: false })
    const s = spawnControllable(rig.registry)
    const res = await prompt(rig.baseUrl, s.id, "hello")
    expect(res.json.result.resultType).toBe("complete")
    const get = await getTask(rig.baseUrl, `task_${"2".repeat(32)}`)
    expect(get.status).toBe(404)
    expect(get.json.error.code).toBe(-32601)
  })

  it("rejects a mismatched Mcp-Name (-32020), an unknown id (-32602) and the legacy tasks/result (-32601)", async () => {
    const rig = await startRig()
    const s = spawnControllable(rig.registry)
    const { taskId } = (await prompt(rig.baseUrl, s.id, "x")).json.result

    const mismatch = await rpc(rig.baseUrl, "tasks/get", { taskId }, taskId, { nameHeader: `task_${"3".repeat(32)}` })
    expect(mismatch.status).toBe(400)
    expect(mismatch.json.error.code).toBe(-32020)

    const unknown = await getTask(rig.baseUrl, `task_${"4".repeat(32)}`)
    expect(unknown.json.error.code).toBe(-32602)

    const legacy = await rpc(rig.baseUrl, "tasks/result", { taskId }, taskId)
    expect(legacy.status).toBe(404)
    expect(legacy.json.error.code).toBe(-32601)
    const list = await rpc(rig.baseUrl, "tasks/list", {}, undefined)
    expect(list.json.error.code).toBe(-32601)
  })

  it("tasks/cancel acknowledges empty, interrupts the turn, and the session stays alive", async () => {
    const rig = await startRig()
    const s = spawnControllable(rig.registry)
    const { taskId } = (await prompt(rig.baseUrl, s.id, "long")).json.result
    await waitFor(() => rig.registry.get(s.id)?.busy === true)

    const ack = await rpc(rig.baseUrl, "tasks/cancel", { taskId }, taskId)
    expect(ack.status).toBe(200)
    expect(ack.json.result.resultType).toBe("complete")
    expect(Object.keys(ack.json.result).filter(k => k !== "_meta" && k !== "resultType")).toEqual([])

    await waitFor(() => (rig.registry.get(s.id)?.turnsCompleted ?? 0) >= 1)
    const after = await getTask(rig.baseUrl, taskId)
    // cooperative: cancelled, or completed if the turn won the race
    expect(["cancelled", "completed"]).toContain(after.json.result.status)
    expect(rig.registry.get(s.id)?.status).toBe("running")
  })

  it("a queued turn reports 'queued' and cancelling it never interrupts the running turn", async () => {
    const rig = await startRig()
    const s = spawnControllable(rig.registry)
    await prompt(rig.baseUrl, s.id, "first", { declare: false })
    await waitFor(() => rig.registry.get(s.id)?.busy === true)

    const queued = (await prompt(rig.baseUrl, s.id, "second")).json.result
    const view = await getTask(rig.baseUrl, queued.taskId)
    expect(view.json.result.status).toBe("working")
    expect(view.json.result.statusMessage).toBe("queued")

    const ack = await rpc(rig.baseUrl, "tasks/cancel", { taskId: queued.taskId }, queued.taskId)
    expect(ack.json.result.resultType).toBe("complete")
    const after = await getTask(rig.baseUrl, queued.taskId)
    expect(after.json.result.status).toBe("cancelled")
    // the first turn is still running, untouched
    expect(rig.registry.get(s.id)?.busy).toBe(true)
    s.finish(1)
  })

  it("a parked permission turns the task input_required and tasks/update unblocks it", async () => {
    const rig = await startRig()
    const fake = parkingAgent()
    const desc = rig.registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fake.agent,
      adapterSlug: "claude-code",
      permissionHold: true,
    })
    const { taskId } = (await prompt(rig.baseUrl, desc.id, "write it", { elicitation: true })).json.result
    await waitFor(() => rig.registry.listPendingPermissions({ sessionId: desc.id }).length > 0)

    const waiting = await getTask(rig.baseUrl, taskId, { elicitation: true })
    expect(waiting.json.result.status).toBe("input_required")
    const keys = Object.keys(waiting.json.result.inputRequests)
    expect(keys).toHaveLength(1)
    expect(waiting.json.result.inputRequests[keys[0]!].method).toBe("elicitation/create")
    // repeated polls give the same open requests (same keys)
    const again = await getTask(rig.baseUrl, taskId, { elicitation: true })
    expect(Object.keys(again.json.result.inputRequests)).toEqual(keys)

    const ack = await rpc(
      rig.baseUrl,
      "tasks/update",
      { taskId, inputResponses: { [keys[0]!]: { action: "accept", content: { decision: "approve", scope: "once" } } } },
      taskId,
      { elicitation: true },
    )
    expect(ack.json.result.resultType).toBe("complete")
    await waitFor(() => (rig.registry.get(desc.id)?.turnsCompleted ?? 0) >= 1)
    expect(fake.responded).toHaveLength(1)

    const done = await getTask(rig.baseUrl, taskId, { elicitation: true })
    expect(done.json.result.status).toBe("completed")
    expect(rig.registry.get(desc.id)?.status).toBe("running")
  })

  it("a session that merely knows the task handle cannot read or drive it", async () => {
    const rig = await startRig()
    const owner = rig.registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: controllableAgent().agent,
      adapterSlug: "fake",
    })
    const child = spawnControllable(rig.registry, { parentSessionId: owner.id })
    const outsider = rig.registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: controllableAgent().agent,
      adapterSlug: "fake",
    })
    const created = await prompt(rig.baseUrl, child.id, "work", { query: `?callerSessionId=${owner.id}` })
    const taskId = created.json.result.taskId as string
    expect(taskId).toBeDefined()

    const seen = await getTask(rig.baseUrl, taskId, { query: `?callerSessionId=${owner.id}` })
    expect(seen.json.result.taskId).toBe(taskId)

    const denied = await getTask(rig.baseUrl, taskId, { query: `?callerSessionId=${outsider.id}` })
    expect(denied.json.error.code).toBe(-32602)
    const cancelDenied = await rpc(rig.baseUrl, "tasks/cancel", { taskId }, taskId, { query: `?callerSessionId=${outsider.id}` })
    expect(cancelDenied.json.error.code).toBe(-32602)
  })

  it("a new daemon over the same ledger still resolves the handle; a session it no longer knows is an unknown id", async () => {
    // The restart case with a persisted, killed row (`failed`, `daemon-restart`) is covered in mcp-modern-tasks.test.ts.
    const dir = mkdtempSync(join(tmpdir(), "agentproto-mcp-tasks-restart-"))
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }))
    const first = await startRig({ dir })
    const s = spawnControllable(first.registry)
    const { taskId } = (await prompt(first.baseUrl, s.id, "work")).json.result

    const second = await startRig({ dir })
    const gone = await getTask(second.baseUrl, taskId)
    expect(gone.json.error.code).toBe(-32602)
  })
})
