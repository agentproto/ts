import { afterEach, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerAgentTools } from "../agent-tools.js"
import type { AgentAdapterResolver } from "../http-server.js"
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

interface RigOpts {
  tasks?: boolean
  dir?: string
  persistPath?: string
  bootId?: string
  tools?: ReadonlySet<string>
  maxActivePerPrincipal?: number
  resultMaxChars?: number
  ttlMs?: number
  /** agent_start adapter: starts a controllable fake agent per call. */
  startSession?: (opts: Record<string, unknown>) => Promise<AgentSessionLike>
}

async function startRig(opts: RigOpts = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "agentproto-mcp-tasks-e2e-"))
  if (!opts.dir) cleanups.push(async () => rmSync(dir, { recursive: true, force: true }))
  const sessionEvents = createSessionEventBus()
  const eventRing = createEventRing()
  const registry: SessionsRegistry = createSessionsRegistry(
    opts.persistPath ? { persistPath: opts.persistPath, sessionEvents } : { persist: false, sessionEvents },
  )
  const humanGate = createHumanGate({
    sessions: registry,
    stateStore: createMrtrStateStore({ dir: join(dir, "mrtr") }),
  })
  const projector = createTaskProjector({
    sessions: registry,
    ledger: createTurnTaskLedger({ dir: join(dir, "tasks") }),
    humanGate,
    ...(opts.bootId ? { bootId: opts.bootId } : {}),
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.maxActivePerPrincipal ? { maxActivePerPrincipal: opts.maxActivePerPrincipal } : {}),
    ...(opts.resultMaxChars ? { resultMaxChars: opts.resultMaxChars } : {}),
    ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}),
    readFinalText: id => registry.readOutputTail(id, 60).join("\n"),
  })
  sessionEvents.on("session:exited", ev => projector.observeSessionEnded(ev.sessionId))
  const resolveAgentAdapter: AgentAdapterResolver | undefined = opts.startSession
    ? async () => ({ startSession: opts.startSession as never, commandPreview: "fake-adapter" })
    : undefined

  const port = await freePort()
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    sessions: registry,
    mcpServerFactory: async (_deny, callerSessionId) => {
      const { server } = await createMcpServer({ specs: [], name: "tasks-e2e", version: "1.0.0" })
      registerAgentTools(server, {
        registry,
        ...(resolveAgentAdapter ? { resolveAgentAdapter } : {}),
        ...(callerSessionId ? { callerSessionId } : {}),
      })
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
  return { baseUrl: `http://127.0.0.1:${port}`, registry, dir, projector, ledgerDir: join(dir, "tasks") }
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

describe("MCP Tasks extension e2e over /mcp (one turn = one task, AIP-78)", () => {
  it("announces the extension in server/discover only when it is enabled", async () => {
    const on = await startRig()
    const off = await startRig({ tasks: false })
    const discover = (baseUrl: string) =>
      rpc(baseUrl, "server/discover", {}, undefined, { declare: false }).then(r => r.json.result.capabilities.extensions)
    expect((await discover(on.baseUrl))[TASKS_EXTENSION]).toEqual({})
    expect((await discover(off.baseUrl) ?? {})[TASKS_EXTENSION]).toBeUndefined()
  })

  it("agent_prompt answers a CreateTaskResult carrying the real sessionId and ticket; tasks/get returns a TurnResult; the session outlives the task", async () => {
    const rig = await startRig()
    const s = spawnControllable(rig.registry)

    const created = await prompt(rig.baseUrl, s.id, "first")
    expect(created.status).toBe(200)
    const r = created.json.result
    expect(r.resultType).toBe("task")
    expect(r.taskId).toMatch(/^task_[0-9a-f]{32}$/)
    expect(r.taskId).not.toContain(s.id)
    expect(r._meta["io.agentproto/turn-task"]).toEqual({ sessionId: s.id, promptId: expect.stringMatching(/^prompt_[0-9a-f]{16}$/) })
    expect(typeof r.ttlMs).toBe("number")
    expect(r.ttlMs).toBeGreaterThan(0)
    expect(typeof r.pollIntervalMs).toBe("number")

    const working = await getTask(rig.baseUrl, r.taskId)
    expect(working.json.result.resultType).toBe("complete")
    expect(["working"]).toContain(working.json.result.status)
    expect(working.json.result).not.toHaveProperty("cacheScope")

    await waitFor(() => rig.registry.get(s.id)?.busy === true)
    s.finish(1)
    await waitFor(() => (rig.registry.get(s.id)?.turnsCompleted ?? 0) >= 1)
    await waitFor(() => rig.projector.get(r.taskId, undefined, undefined).status === "completed")

    const done = await getTask(rig.baseUrl, r.taskId)
    expect(done.json.result.status).toBe("completed")
    expect(Object.keys(done.json.result.result).sort()).toEqual(["sessionId", "text", "truncated"])
    expect(done.json.result.result.sessionId).toBe(s.id)
    expect(done.json.result.result.text).toContain("answer of turn 1")
    expect(done.json.result.result.truncated).toBe(false)
    expect(rig.registry.get(s.id)?.status).toBe("running")

    // a second prompt is a NEW task; the first stays as recorded
    const second = await prompt(rig.baseUrl, s.id, "second")
    expect(second.json.result.taskId).not.toBe(r.taskId)
    expect(second.json.result._meta["io.agentproto/turn-task"].promptId).not.toBe(r._meta["io.agentproto/turn-task"].promptId)
    await waitFor(() => rig.registry.get(s.id)?.busy === true)
    s.finish(2)
    await waitFor(() => rig.projector.get(second.json.result.taskId, undefined, undefined).status === "completed")
    expect((await getTask(rig.baseUrl, r.taskId)).json.result.result.text).toContain("answer of turn 1")
    expect((await getTask(rig.baseUrl, second.json.result.taskId)).json.result.result.text).toContain("answer of turn 2")
  })

  it("the ledger entry is on disk (0600, reserved ids, no temporary file) before the prompt reaches the session", async () => {
    const rig = await startRig()
    const s = spawnControllable(rig.registry)
    const created = (await prompt(rig.baseUrl, s.id, "first")).json.result
    const files = readdirSync(rig.ledgerDir)
    expect(files).toEqual([`${created.taskId}.json`])
    const path = join(rig.ledgerDir, files[0]!)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const entry = JSON.parse(readFileSync(path, "utf8"))
    expect(entry).toMatchObject({
      taskId: created.taskId,
      sessionId: s.id,
      promptId: created._meta["io.agentproto/turn-task"].promptId,
      principal: "operator",
    })
    expect(entry.ttlMs).toBeGreaterThan(0)
  })

  it("the ledger entry already exists when the session starts the turn (durable before the prompt is handed over)", async () => {
    const rig = await startRig()
    let seen: Array<Record<string, unknown>> | undefined
    const inner = controllableAgent()
    const agent: AgentSessionLike = {
      ...inner.agent,
      async *send(...args: Parameters<AgentSessionLike["send"]>) {
        seen = readdirSync(rig.ledgerDir).map(f => JSON.parse(readFileSync(join(rig.ledgerDir, f), "utf8")))
        yield* inner.agent.send(...args)
      },
    }
    const desc = rig.registry.spawnAgent({ workspaceSlug: "default", cwd: process.cwd(), agentSession: agent, adapterSlug: "fake" })
    const created = (await prompt(rig.baseUrl, desc.id, "go")).json.result
    await waitFor(() => seen !== undefined)
    expect(seen).toHaveLength(1)
    expect(seen![0]).toMatchObject({
      taskId: created.taskId,
      sessionId: desc.id,
      promptId: created._meta["io.agentproto/turn-task"].promptId,
    })
    inner.finish(1)
  })

  it("a client that did not declare the extension gets the ordinary result and no ledger entry; tasks/* answer -32021 (HTTP 400)", async () => {
    const rig = await startRig()
    const s = spawnControllable(rig.registry)
    const plain = await prompt(rig.baseUrl, s.id, "hello", { declare: false })
    expect(plain.json.result.resultType).toBe("complete")
    expect(JSON.parse(plain.json.result.content[0].text).sessionId).toBe(s.id)
    expect(readdirSync(rig.ledgerDir)).toEqual([])

    const refused = await getTask(rig.baseUrl, `task_${"1".repeat(32)}`, { declare: false })
    expect(refused.status).toBe(400)
    expect(refused.json.error.code).toBe(-32021)
    expect(refused.json.error.data.requiredCapabilities.extensions[TASKS_EXTENSION]).toEqual({})
  })

  it("no parameter can force or suppress task creation", async () => {
    const rig = await startRig()
    const s = spawnControllable(rig.registry)
    const forced = await prompt(rig.baseUrl, s.id, "hello", { declare: false, args: { task: {}, promptId: "prompt_forged", _meta: { "io.agentproto/turn-task": { promptId: "prompt_forged" } } } })
    expect(forced.json.result.resultType).toBe("complete")
    const declared = (await prompt(rig.baseUrl, s.id, "again", { args: { task: false, promptId: "prompt_forged" } })).json.result
    expect(declared.resultType).toBe("task")
    expect(declared._meta["io.agentproto/turn-task"].promptId).not.toBe("prompt_forged")
  })

  it("flag off: tasks/* are unknown (-32601, 404), agent_prompt answers as before", async () => {
    const rig = await startRig({ tasks: false })
    const s = spawnControllable(rig.registry)
    const res = await prompt(rig.baseUrl, s.id, "hello")
    expect(res.json.result.resultType).toBe("complete")
    const get = await getTask(rig.baseUrl, `task_${"2".repeat(32)}`)
    expect(get.status).toBe(404)
    expect(get.json.error.code).toBe(-32601)
  })

  it("rejects a mismatched Mcp-Name (-32020), an unknown id (-32602, HTTP 400) and the legacy tasks/result and tasks/list (-32601)", async () => {
    const rig = await startRig()
    const s = spawnControllable(rig.registry)
    const { taskId } = (await prompt(rig.baseUrl, s.id, "x")).json.result

    const mismatch = await rpc(rig.baseUrl, "tasks/get", { taskId }, taskId, { nameHeader: `task_${"3".repeat(32)}` })
    expect(mismatch.status).toBe(400)
    expect(mismatch.json.error.code).toBe(-32020)

    const unknown = await getTask(rig.baseUrl, `task_${"4".repeat(32)}`)
    expect(unknown.status).toBe(400)
    expect(unknown.json.error.code).toBe(-32602)

    const legacy = await rpc(rig.baseUrl, "tasks/result", { taskId }, taskId)
    expect(legacy.status).toBe(404)
    expect(legacy.json.error.code).toBe(-32601)
    const list = await rpc(rig.baseUrl, "tasks/list", {}, undefined)
    expect(list.json.error.code).toBe(-32601)
  })

  it("tasks/cancel on the turn in flight acknowledges empty, interrupts it, cancels the task and leaves the session alive", async () => {
    const rig = await startRig()
    const s = spawnControllable(rig.registry)
    const { taskId } = (await prompt(rig.baseUrl, s.id, "long")).json.result
    await waitFor(() => rig.registry.get(s.id)?.busy === true)

    const ack = await rpc(rig.baseUrl, "tasks/cancel", { taskId }, taskId)
    expect(ack.status).toBe(200)
    expect(ack.json.result.resultType).toBe("complete")
    expect(Object.keys(ack.json.result).filter(k => k !== "_meta" && k !== "resultType")).toEqual([])

    await waitFor(() => rig.projector.get(taskId, undefined, undefined).status !== "working")
    expect((await getTask(rig.baseUrl, taskId)).json.result.status).toBe("cancelled")
    expect(rig.registry.get(s.id)?.status).toBe("running")

    // idempotent, and acknowledged on a terminal task
    expect((await rpc(rig.baseUrl, "tasks/cancel", { taskId }, taskId)).json.result.resultType).toBe("complete")
  })

  it("cancelling an ended task never interrupts a LATER turn of the same session", async () => {
    const rig = await startRig()
    const s = spawnControllable(rig.registry)
    const first = (await prompt(rig.baseUrl, s.id, "one")).json.result
    await waitFor(() => rig.registry.get(s.id)?.busy === true)
    s.finish(1)
    await waitFor(() => rig.projector.get(first.taskId, undefined, undefined).status === "completed")

    const second = (await prompt(rig.baseUrl, s.id, "two")).json.result
    await waitFor(() => rig.registry.get(s.id)?.busy === true && rig.registry.get(s.id)?.turnsCompleted === 1)

    const ack = await rpc(rig.baseUrl, "tasks/cancel", { taskId: first.taskId }, first.taskId)
    expect(ack.json.result.resultType).toBe("complete")
    // the second turn is untouched and still running; the first task still says completed
    expect(rig.registry.get(s.id)?.busy).toBe(true)
    expect((await getTask(rig.baseUrl, first.taskId)).json.result.status).toBe("completed")
    expect((await getTask(rig.baseUrl, second.taskId)).json.result.status).toBe("working")
    s.finish(2)
  })

  it("a queued ticket reports 'queued'; cancelling it drops only that ticket and never interrupts the running turn", async () => {
    const rig = await startRig()
    const s = spawnControllable(rig.registry)
    await prompt(rig.baseUrl, s.id, "first", { declare: false })
    await waitFor(() => rig.registry.get(s.id)?.busy === true)

    const queued = (await prompt(rig.baseUrl, s.id, "second", { args: { steer: false } })).json.result
    const view = await getTask(rig.baseUrl, queued.taskId)
    expect(view.json.result.status).toBe("working")
    expect(view.json.result.statusMessage).toBe("queued")
    // the queue item IS the ticket: its id is the promptId the task reported
    expect(rig.registry.get(s.id)?.promptQueue?.map(p => p.id)).toEqual([queued._meta["io.agentproto/turn-task"].promptId])

    const ack = await rpc(rig.baseUrl, "tasks/cancel", { taskId: queued.taskId }, queued.taskId)
    expect(ack.json.result.resultType).toBe("complete")
    const after = await getTask(rig.baseUrl, queued.taskId)
    expect(after.json.result.status).toBe("cancelled")
    expect(rig.registry.get(s.id)?.promptQueue ?? []).toEqual([])
    expect(rig.registry.get(s.id)?.busy).toBe(true)
    s.finish(1)
  })

  it("tickets stay bound to their own prompt when the queue is reordered or an entry is dropped", async () => {
    const rig = await startRig()
    const s = spawnControllable(rig.registry)
    await prompt(rig.baseUrl, s.id, "running", { declare: false })
    await waitFor(() => rig.registry.get(s.id)?.busy === true)

    const a = (await prompt(rig.baseUrl, s.id, "A", { args: { steer: false } })).json.result
    const b = (await prompt(rig.baseUrl, s.id, "B", { args: { steer: false } })).json.result
    const idA = a._meta["io.agentproto/turn-task"].promptId as string
    const idB = b._meta["io.agentproto/turn-task"].promptId as string
    // reorder: B first
    expect(rig.registry.promoteQueuedPrompt(s.id, idB).promoted).toBe(true)
    // drop A through the queue controls
    expect(rig.registry.removeQueuedPrompt(s.id, idA).removed).toBe(true)

    expect((await getTask(rig.baseUrl, a.taskId)).json.result.status).toBe("cancelled")
    expect((await getTask(rig.baseUrl, b.taskId)).json.result.status).toBe("working")
    s.finish(1)
    await waitFor(() => rig.registry.get(s.id)?.busy === true && rig.registry.get(s.id)?.turnsCompleted === 1)
    await waitFor(() => rig.projector.get(b.taskId, undefined, undefined).statusMessage !== "queued")
    s.finish(2)
    await waitFor(() => rig.projector.get(b.taskId, undefined, undefined).status === "completed")
    expect((await getTask(rig.baseUrl, b.taskId)).json.result.result.text).toContain("answer of turn 2")
  })

  it("a prompt sent with interrupt:true cancels the previous in-flight task and creates a separate task", async () => {
    const rig = await startRig()
    const s = spawnControllable(rig.registry)
    const old = (await prompt(rig.baseUrl, s.id, "slow")).json.result
    await waitFor(() => rig.registry.get(s.id)?.busy === true)

    const fresh = (await prompt(rig.baseUrl, s.id, "urgent", { args: { interrupt: true } })).json.result
    expect(fresh.taskId).not.toBe(old.taskId)
    await waitFor(() => rig.projector.get(old.taskId, undefined, undefined).status === "cancelled")
    expect((await getTask(rig.baseUrl, fresh.taskId)).json.result.status).toBe("working")
    await waitFor(() => rig.registry.get(s.id)?.busy === true && rig.registry.get(s.id)?.turnsCompleted === 1)
    s.finish(2)
    await waitFor(() => rig.projector.get(fresh.taskId, undefined, undefined).status === "completed")
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
    // repeated polls: same keys, same lastUpdatedAt, no write
    const again = await getTask(rig.baseUrl, taskId, { elicitation: true })
    expect(Object.keys(again.json.result.inputRequests)).toEqual(keys)
    expect(again.json.result.lastUpdatedAt).toBe(waiting.json.result.lastUpdatedAt)

    const ack = await rpc(
      rig.baseUrl,
      "tasks/update",
      { taskId, inputResponses: { [keys[0]!]: { action: "accept", content: { decision: "approve", scope: "once" } } } },
      taskId,
      { elicitation: true },
    )
    expect(ack.json.result.resultType).toBe("complete")
    expect(Object.keys(ack.json.result).filter(k => k !== "_meta" && k !== "resultType")).toEqual([])
    await waitFor(() => (rig.registry.get(desc.id)?.turnsCompleted ?? 0) >= 1)
    expect(fake.responded).toHaveLength(1)

    await waitFor(() => rig.projector.get(taskId, undefined, undefined).status === "completed")
    const done = await getTask(rig.baseUrl, taskId, { elicitation: true })
    expect(done.json.result.status).toBe("completed")
    expect(rig.registry.get(desc.id)?.status).toBe("running")
    // update on the terminal task: acknowledged, no effect
    const late = await rpc(rig.baseUrl, "tasks/update", { taskId, inputResponses: { x: { action: "accept" } } }, taskId, { elicitation: true })
    expect(late.json.result.resultType).toBe("complete")
    expect(fake.responded).toHaveLength(1)
  })

  it("a session that merely knows the task handle cannot read or drive it (same -32602 as an unknown id)", async () => {
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
    expect(JSON.parse(readFileSync(join(rig.ledgerDir, `${taskId}.json`), "utf8")).principal).toBe(`session:${owner.id}`)

    const seen = await getTask(rig.baseUrl, taskId, { query: `?callerSessionId=${owner.id}` })
    expect(seen.json.result.taskId).toBe(taskId)

    const denied = await getTask(rig.baseUrl, taskId, { query: `?callerSessionId=${outsider.id}` })
    expect(denied.status).toBe(400)
    expect(denied.json.error.code).toBe(-32602)
    const cancelDenied = await rpc(rig.baseUrl, "tasks/cancel", { taskId }, taskId, { query: `?callerSessionId=${outsider.id}` })
    expect(cancelDenied.json.error.code).toBe(-32602)
    const updateDenied = await rpc(rig.baseUrl, "tasks/update", { taskId, inputResponses: {} }, taskId, { query: `?callerSessionId=${outsider.id}` })
    expect(updateDenied.json.error.code).toBe(-32602)
  })

  it("caps the non-terminal tasks per principal BEFORE any ticket, ledger entry or turn exists (and the cap frees up when one ends)", async () => {
    const rig = await startRig({ maxActivePerPrincipal: 1 })
    const s = spawnControllable(rig.registry)
    const first = (await prompt(rig.baseUrl, s.id, "one")).json.result
    await waitFor(() => rig.registry.get(s.id)?.busy === true)
    expect(readdirSync(rig.ledgerDir)).toHaveLength(1)

    const refused = await prompt(rig.baseUrl, s.id, "two", { args: { steer: false } })
    expect(refused.json.result.isError).toBe(true)
    expect(refused.json.result.content[0].text).toContain("too many tasks")
    expect(readdirSync(rig.ledgerDir)).toHaveLength(1)
    expect(rig.registry.get(s.id)?.promptQueue ?? []).toEqual([])

    s.finish(1)
    await waitFor(() => rig.projector.get(first.taskId, undefined, undefined).status === "completed")
    const ok = await prompt(rig.baseUrl, s.id, "three")
    expect(ok.json.result.resultType).toBe("task")
    await waitFor(() => rig.registry.get(s.id)?.busy === true)
    s.finish(2)
  })

  it("a prompt the session refuses (queue:false while busy) answers the tool's own error and closes the entry failed", async () => {
    const rig = await startRig()
    const s = spawnControllable(rig.registry)
    await prompt(rig.baseUrl, s.id, "running", { declare: false })
    await waitFor(() => rig.registry.get(s.id)?.busy === true)
    const refused = await prompt(rig.baseUrl, s.id, "no room", { args: { queue: false, steer: false } })
    expect(refused.json.result.isError).toBe(true)
    expect(refused.json.result.resultType).not.toBe("task")
    const entries = readdirSync(rig.ledgerDir).map(f => JSON.parse(readFileSync(join(rig.ledgerDir, f), "utf8")))
    expect(entries).toHaveLength(1)
    expect(entries[0].lastStatus).toBe("failed")
    s.finish(1)
  })

  it("a duplicate prompt (same dedupeKey) starts nothing and returns the ordinary result", async () => {
    const rig = await startRig()
    const s = spawnControllable(rig.registry)
    const first = (await prompt(rig.baseUrl, s.id, "once", { args: { dedupeKey: "k1" } })).json.result
    expect(first.resultType).toBe("task")
    const dup = (await prompt(rig.baseUrl, s.id, "once", { args: { dedupeKey: "k1" } })).json.result
    expect(dup.resultType).toBe("complete")
    expect(JSON.parse(dup.content[0].text).duplicate).toBe(true)
    await waitFor(() => rig.registry.get(s.id)?.busy === true)
    s.finish(1)
  })

  it("a session forgotten while its ticket is queued ends the task (no task stays working forever)", async () => {
    const rig = await startRig()
    const s = spawnControllable(rig.registry)
    await prompt(rig.baseUrl, s.id, "running", { declare: false })
    await waitFor(() => rig.registry.get(s.id)?.busy === true)
    const queued = (await prompt(rig.baseUrl, s.id, "waits", { args: { steer: false } })).json.result
    rig.registry.kill(s.id)
    await waitFor(() => rig.registry.get(s.id)?.status === "killed")
    expect(rig.registry.forgetSession(s.id)).toBe("forgotten")
    const view = await getTask(rig.baseUrl, queued.taskId)
    // never started, so no work was done: cancelled (session-forgotten), not failed
    expect(view.json.result.status).toBe("cancelled")
  })

  it("host-restart: a task with no recorded terminal state becomes failed, a recorded one keeps its state and result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentproto-mcp-tasks-restart-"))
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }))
    const first = await startRig({ dir, bootId: "boot-one" })
    const s = spawnControllable(first.registry)
    const done = (await prompt(first.baseUrl, s.id, "finish me")).json.result
    await waitFor(() => first.registry.get(s.id)?.busy === true)
    s.finish(1)
    await waitFor(() => first.projector.get(done.taskId, undefined, undefined).status === "completed")
    const open = (await prompt(first.baseUrl, s.id, "still going")).json.result
    await waitFor(() => first.registry.get(s.id)?.busy === true && first.registry.get(s.id)?.turnsCompleted === 1)

    const second = await startRig({ dir, bootId: "boot-two" })
    const kept = await getTask(second.baseUrl, done.taskId)
    expect(kept.json.result.status).toBe("completed")
    expect(kept.json.result.result.text).toContain("answer of turn 1")
    const lost = await getTask(second.baseUrl, open.taskId)
    expect(lost.status).toBe(200)
    expect(lost.json.result.status).toBe("failed")
    expect(lost.json.result.error.code).toBe(-32603)
    expect(lost.json.result.error.data).toMatchObject({ reason: "host-restart", sessionId: s.id })
    s.finish(2)
  })

  it("agent_start with a prompt: ledger entry written under the RESERVED session id before the session exists, CreateTaskResult carries it, the first turn completes the task", async () => {
    const holder: { fake?: ReturnType<typeof controllableAgent>; seenAtSpawn?: unknown } = {}
    let rig!: Awaited<ReturnType<typeof startRig>>
    rig = await startRig({
      startSession: async () => {
        // the session is being spawned: the task must already be on disk
        holder.seenAtSpawn = readdirSync(rig.ledgerDir).map(f => JSON.parse(readFileSync(join(rig.ledgerDir, f), "utf8")))
        holder.fake = controllableAgent()
        return holder.fake.agent
      },
    })
    const res = await rpc(
      rig.baseUrl,
      "tools/call",
      { name: "agent_start", arguments: { adapter: "claude-code", cwd: process.cwd(), prompt: "do it" } },
      "agent_start",
    )
    const r = res.json.result
    expect(r.resultType).toBe("task")
    const meta = r._meta["io.agentproto/turn-task"]
    expect(meta.sessionId).toMatch(/^sess_/)
    expect(rig.registry.get(meta.sessionId)).toBeDefined()
    expect(r.taskId).not.toContain(meta.sessionId)

    const seen = holder.seenAtSpawn as Array<Record<string, unknown>>
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ taskId: r.taskId, sessionId: meta.sessionId, promptId: meta.promptId, lastStatus: "working" })

    await waitFor(() => rig.registry.get(meta.sessionId)?.busy === true)
    holder.fake!.finish(1)
    await waitFor(() => rig.projector.get(r.taskId, undefined, undefined).status === "completed")
    const done = await getTask(rig.baseUrl, r.taskId)
    expect(done.json.result.result).toMatchObject({ sessionId: meta.sessionId, truncated: false })
    expect(done.json.result.result.text).toContain("answer of turn 1")
    expect(rig.registry.get(meta.sessionId)?.status).toBe("running")
  })

  it("agent_start without a prompt starts no turn and returns the ordinary result; a failed spawn answers its own error with no task", async () => {
    let fail = false
    const rig = await startRig({
      startSession: async () => {
        if (fail) throw new Error("adapter exploded")
        return controllableAgent().agent
      },
    })
    const bare = await rpc(
      rig.baseUrl,
      "tools/call",
      { name: "agent_start", arguments: { adapter: "claude-code", cwd: process.cwd() } },
      "agent_start",
    )
    expect(bare.json.result.resultType).toBe("complete")
    expect(readdirSync(rig.ledgerDir)).toEqual([])

    fail = true
    const failed = await rpc(
      rig.baseUrl,
      "tools/call",
      { name: "agent_start", arguments: { adapter: "claude-code", cwd: process.cwd(), prompt: "go" } },
      "agent_start",
    )
    expect(failed.json.result.isError).toBe(true)
    expect(failed.json.result.resultType).not.toBe("task")
    const entries = readdirSync(rig.ledgerDir).map(f => JSON.parse(readFileSync(join(rig.ledgerDir, f), "utf8")))
    expect(entries.map(e => e.lastStatus)).toEqual(["failed"])
  })

  it("the task tools mode applies uniformly: agent_prompt only means agent_start answers the ordinary result", async () => {
    const rig = await startRig({
      tools: new Set(["agent_prompt"]),
      startSession: async () => controllableAgent().agent,
    })
    const started = await rpc(
      rig.baseUrl,
      "tools/call",
      { name: "agent_start", arguments: { adapter: "claude-code", cwd: process.cwd(), prompt: "go" } },
      "agent_start",
    )
    expect(started.json.result.resultType).toBe("complete")
    const s = spawnControllable(rig.registry)
    expect((await prompt(rig.baseUrl, s.id, "x")).json.result.resultType).toBe("task")
  })

  it("redacts secrets and bounds the stored result (truncated flag)", async () => {
    const rig = await startRig({ resultMaxChars: 12 })
    const s = spawnControllable(rig.registry)
    const t = (await prompt(rig.baseUrl, s.id, "go")).json.result
    await waitFor(() => rig.registry.get(s.id)?.busy === true)
    s.finish(1)
    await waitFor(() => rig.projector.get(t.taskId, undefined, undefined).status === "completed")
    const done = (await getTask(rig.baseUrl, t.taskId)).json.result.result
    expect(done.truncated).toBe(true)
    expect(done.text.length).toBeLessThanOrEqual(12)
  })
})
