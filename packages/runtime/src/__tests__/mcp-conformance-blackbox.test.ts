/**
 * Black-box conformance replay of `/mcp` (protocol 2026-07-28 and its Tasks and Skills extensions).
 *
 * The cases are NOT listed here: they are read from the fixture folders `fixtures/mcp-2026-07-28/` and
 * `fixtures/mcp-skills-ext-beta/`, in file-name order. A fixture takes part when it carries a `_conformance` array;
 * any other fixture is skipped and counted (see the last test). Each case runs against a real HTTP server
 * (`startHttpServer`, a fresh one per case, loopback only, no external network) wired like the daemon: the
 * `mcp.humanGate`, `mcp.tasks` and `mcp.extensions.skills` flags are read per request from `FLAGS` below.
 *
 * A case may name a `given` scenario (the state the server must be in), a `request` (another fixture, or an inline
 * `{ method, params }`), `set` paths with `$vars` from the scenario, `clientCapabilities`, `_meta` and header
 * overrides, a `caller` session, a `mutate` step and a `repeat` count. `docs/mcp-conformance-matrix.md` is generated
 * from the same blocks by `scripts/mcp-conformance-matrix.mjs`.
 */
import { afterEach, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"
import { registerOrchestrationTools } from "../orchestration-tools.js"
import { registerAgentTools } from "../agent-tools.js"
import { createApprovalsEngine } from "../approvals/engine.js"
import { registerApprovalTools } from "../approvals/tools.js"
import { createSessionsRegistry, type AgentSessionLike, type SessionsRegistry } from "../sessions.js"
import { registerServedSkills } from "../mcp-modern/skills.js"
import { importSkill } from "../skill-imports.js"
import {
  createHumanGate,
  createMrtrStateStore,
  createTaskProjector,
  createTurnTaskLedger,
  type TaskProjector,
} from "../mcp-modern/index.js"
import { resolveHumanGate, resolveHumanGateSurfaces, resolveModernEra, resolveSkillsExtension, resolveTaskSettings } from "../mcp-config.js"
import type { McpConfig } from "../config.js"

type Json = Record<string, any>

/** The daemon defaults. The red proof of the PR turns one of them off locally and watches its surface fail. */
const FLAGS: McpConfig = { modernEra: true, humanGate: true, humanGateApprovals: true, humanGateRuns: true, tasks: true, extensions: { skills: true } }
const UI_BASE = "https://console.example.test/approvals"
const VERSION = "2026-07-28"
const META_VERSION = "io.modelcontextprotocol/protocolVersion"
const META_CAPS = "io.modelcontextprotocol/clientCapabilities"
const META_INFO = "io.modelcontextprotocol/clientInfo"
const TASK_KEYS = ["resultType", "taskId", "status", "statusMessage", "createdAt", "lastUpdatedAt", "ttlMs", "pollIntervalMs", "inputRequests", "result", "error"]
/** `Mcp-Name` source per method: streamable-http 'Standard Request Headers' and SEP-2663 'Routing Headers'. */
const NAME_SOURCE: Record<string, string> = {
  "tools/call": "name",
  "prompts/get": "name",
  "resources/read": "uri",
  "tasks/get": "taskId",
  "tasks/update": "taskId",
  "tasks/cancel": "taskId",
}
const DAY = 24 * 60 * 60 * 1000

// ── Discovery ──────────────────────────────────────────────────────────────

const FIXTURE_DIRS = ["mcp-2026-07-28", "mcp-skills-ext-beta"].map(dir => fileURLToPath(new URL(`./fixtures/${dir}/`, import.meta.url)))

interface Fixture {
  dir: string
  file: string
  name: string
  json: Json
}

interface ConformanceCase {
  case: "positive" | "negative"
  /** The JSON-RPC method on the wire; checked against the request the case sends. */
  method: string
  era: string
  surface: string
  title: string
  capability: string
  given?: string
  request?: string | { method: string; params?: Json }
  set?: Json
  clientCapabilities?: Json
  meta?: Json
  headers?: Record<string, string | null>
  caller?: string
  mutate?: "tamper-request-state" | "advance-clock"
  repeat?: number
  /** The status this case expects is what the spec says; the code answers otherwise today. */
  knownDefect?: string
  expect: Json
}

function discover(): { replayed: Array<{ fixture: Fixture; cases: ConformanceCase[] }>; ignored: string[] } {
  const replayed: Array<{ fixture: Fixture; cases: ConformanceCase[] }> = []
  const ignored: string[] = []
  for (const dir of FIXTURE_DIRS) {
    for (const file of readdirSync(dir).filter(f => f.endsWith(".json")).sort()) {
      const json = JSON.parse(readFileSync(join(dir, file), "utf8")) as Json
      const fixture = { dir, file, name: file.replace(/\.json$/, ""), json }
      if (Array.isArray(json._conformance)) replayed.push({ fixture, cases: json._conformance as ConformanceCase[] })
      else ignored.push(`${dir.split("/").filter(Boolean).pop()}/${file}`)
    }
  }
  return { replayed, ignored }
}

const DISCOVERED = discover()

function sibling(fixture: Fixture, name: string): Json {
  return JSON.parse(readFileSync(join(fixture.dir, `${name}.json`), "utf8")) as Json
}

// ── Rig ────────────────────────────────────────────────────────────────────

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

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

interface Rig {
  baseUrl: string
  registry: SessionsRegistry
  engine: ReturnType<typeof createApprovalsEngine>
  projector: () => TaskProjector
  skillPaths: { registryPath: string; root: string }
  work: string
  advanceClock(ms: number): void
  restartTasks(): void
}

async function startRig(): Promise<Rig> {
  const work = mkdtempSync(join(tmpdir(), "agentproto-mcp-conformance-"))
  cleanups.push(() => rmSync(work, { recursive: true, force: true }))
  const load = async () => ({ mcp: FLAGS, approvals: { uiBaseUrl: UI_BASE } })
  let offset = 0
  const now = () => Date.now() + offset
  const sessionEvents = createSessionEventBus()
  const eventRing = createEventRing()
  const registry = createSessionsRegistry({ persist: false, sessionEvents })
  const engine = createApprovalsEngine({ homeDir: join(work, "home"), sessionEvents, webOrigins: ["https://console.example.test"] })
  const humanGate = createHumanGate({
    sessions: registry,
    stateStore: createMrtrStateStore({ dir: join(work, "mrtr"), now }),
    approvals: engine,
    surfaces: () => resolveHumanGateSurfaces(load),
    log: () => {},
  })
  const newProjector = (bootId: string) =>
    createTaskProjector({
      sessions: registry,
      ledger: createTurnTaskLedger({ dir: join(work, "tasks"), now }),
      humanGate,
      bootId,
      now,
      readFinalText: id => registry.readOutputTail(id, 60).join("\n"),
    })
  let projector = newProjector("boot-one")
  sessionEvents.on("session:exited", ev => projector.observeSessionEnded(ev.sessionId))
  const skillPaths = { registryPath: join(work, "imported-skills.json"), root: join(work, "skills") }

  const port = await freePort()
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    sessions: registry,
    mcpServerFactory: async (_deny, callerSessionId) => {
      const { server } = await createMcpServer({ specs: [], name: "conformance", version: "1.0.0" })
      // The tool of the spec examples, so a page's tools/call can be replayed as written.
      server.tool("get_weather", "Get current weather information for a location", { location: z.string().optional(), city: z.string().optional() }, async input => ({
        content: [{ type: "text", text: `Current weather in ${input.location ?? input.city ?? "?"}` }],
      }))
      registerAgentTools(server, { registry, ...(callerSessionId ? { callerSessionId } : {}) })
      registerOrchestrationTools(server, { registry, sessionEvents, eventRing, ...(callerSessionId ? { callerSessionId } : {}) })
      registerApprovalTools(server, { engine, ...(callerSessionId ? { callerSessionId } : {}) })
      return server
    },
    mcpModern: {
      enabled: () => resolveModernEra(load),
      extensions: {},
      humanGate: async () => ((await resolveHumanGate(load)) ? humanGate : undefined),
      decorateServer: async server => {
        if (await resolveSkillsExtension(load)) registerServedSkills(server, skillPaths)
      },
      tasks: async () => ((await resolveTaskSettings(load)).enabled ? projector : undefined),
    },
    conversations: {
      async open() {},
      async appendTurn() {},
      async read() {
        return { meta: {} as never, turns: [] }
      },
      async list() {
        return []
      },
      pathFor: (id: string) => id,
    },
    events: createRuntimeEvents(),
    heartbeat: { start() {}, stop() {}, async fireNow() {} },
    meta: { workspace: process.cwd(), registered: [] },
  })
  cleanups.push(async () => {
    await http.stop()
    registry.shutdown()
  })
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    registry,
    engine,
    projector: () => projector,
    skillPaths,
    work,
    advanceClock: ms => {
      offset += ms
    },
    restartTasks: () => {
      projector = newProjector("boot-two")
    },
  }
}

// ── Wire ───────────────────────────────────────────────────────────────────

interface Reply {
  status: number
  headers: Headers
  json: Json
}

async function post(rig: Rig, body: Json, headers: Record<string, string>, caller?: string): Promise<Reply> {
  const res = await fetch(`${rig.baseUrl}/mcp${caller ? `?callerSessionId=${encodeURIComponent(caller)}` : ""}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, headers: res.headers, json: JSON.parse(text) as Json }
}

/** A plain modern call used by the scenarios themselves (not a fixture). */
async function rpc(rig: Rig, method: string, params: Json, caps: Json, caller?: string): Promise<Reply> {
  const body = { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { [META_VERSION]: VERSION, [META_CAPS]: caps } } }
  return post(rig, body, headersFor(body), caller)
}

function headersFor(body: Json): Record<string, string> {
  const method = String(body.method)
  const out: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": String(body.params?._meta?.[META_VERSION] ?? VERSION),
    "mcp-method": method,
  }
  const source = NAME_SOURCE[method]
  const value = source ? body.params?.[source] : undefined
  if (typeof value === "string") out["mcp-name"] = value
  return out
}

const TASKS_CAPS = { extensions: { "io.modelcontextprotocol/tasks": {} } }

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms
  while (!check() && Date.now() < until) await new Promise(r => setTimeout(r, 5))
  expect(check()).toBe(true)
}

// ── Scenarios ──────────────────────────────────────────────────────────────

/** A fake agent whose turns end only when the test releases them (or a cancel interrupts the running one). */
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
  return { agent, finish: (n: number) => releases[n - 1]?.("completed") }
}

/** A fake agent that parks one permission (or question) prompt and ends its turn once it is answered. */
function parkingAgent(extra: Json = {}) {
  const responded: unknown[] = []
  let release: (() => void) | null = null
  const agent: AgentSessionLike = {
    sessionId: "parking",
    pid: 4242,
    async *send() {
      yield {
        kind: "agent-prompt",
        toolCallId: "perm-conformance",
        toolName: "Write",
        text: 'Allow "Write"?',
        options: [
          { optionId: "opt-once", name: "Allow once", kind: "allow_once" },
          { optionId: "opt-reject", name: "Reject", kind: "reject_once" },
        ],
        ...extra,
      }
      await new Promise<void>(r => {
        release = r
      })
      yield { kind: "turn-end", reason: "completed" }
    },
    respondPermission(_id, resolution) {
      responded.push(resolution)
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

interface Given {
  vars: Record<string, unknown>
  permissionResolved?: () => boolean
}

function spawn(rig: Rig, agent: AgentSessionLike, extra: Json = {}): string {
  return rig.registry.spawnAgent({ workspaceSlug: "default", cwd: process.cwd(), agentSession: agent, adapterSlug: "claude-code", ...extra }).id
}

async function parkPermission(rig: Rig, extra: Json = {}): Promise<Given> {
  const fake = parkingAgent(extra)
  const sessionId = spawn(rig, fake.agent, { permissionHold: true })
  void rig.registry.sendPrompt(sessionId, "go").catch(() => {})
  await waitFor(() => rig.registry.listPendingPermissions({ sessionId }).length > 0)
  const outsiderId = spawn(rig, controllableAgent().agent)
  return { vars: { sessionId, outsiderId }, permissionResolved: () => fake.responded.length === 1 }
}

async function startTask(rig: Rig): Promise<{ vars: Record<string, unknown>; finish: (n: number) => void }> {
  const fake = controllableAgent()
  const sessionId = spawn(rig, fake.agent)
  const created = await rpc(rig, "tools/call", { name: "agent_prompt", arguments: { sessionId, prompt: "go" } }, TASKS_CAPS)
  const taskId = created.json.result?.taskId as string
  expect(taskId, "the scenario could not create a task").toBeDefined()
  await waitFor(() => rig.registry.get(sessionId)?.busy === true)
  return { vars: { sessionId, taskId }, finish: fake.finish }
}

const SCENARIOS: Record<string, (rig: Rig) => Promise<Given>> = {
  async "session-idle"(rig) {
    return { vars: { sessionId: spawn(rig, controllableAgent().agent) } }
  },
  "permission-parked": rig => parkPermission(rig),
  async "permission-input-required"(rig) {
    const given = await parkPermission(rig)
    const first = await rpc(rig, "tools/call", { name: "permissions_list", arguments: { sessionId: given.vars.sessionId } }, { elicitation: { form: {} } })
    expect(first.json.result?.resultType, "the scenario could not reach input_required").toBe("input_required")
    given.vars.requestState = first.json.result.requestState
    given.vars.inputKey = Object.keys(first.json.result.inputRequests)[0]
    return given
  },
  "question-secret-parked": rig =>
    parkPermission(rig, {
      text: "Credentials",
      request: "question",
      question: { prompt: "Provide credentials", choices: [], allowFreeText: false, fields: [{ id: "api_key", input: "text", prompt: "Your API key", required: true }] },
    }),
  async "approval-pending"(rig) {
    const record = rig.engine.request({ kind: "send", title: "Send the weekly digest", preview: {}, payload: { to: "a" } }, { operator: true })
    return { vars: { approvalId: record.id } }
  },
  async "task-working"(rig) {
    return { vars: (await startTask(rig)).vars }
  },
  async "task-completed"(rig) {
    const task = await startTask(rig)
    task.finish(1)
    await waitFor(() => rig.projector().get(String(task.vars.taskId), undefined, undefined).status === "completed")
    return { vars: task.vars }
  },
  async "task-cancelled"(rig) {
    const task = await startTask(rig)
    const ack = await rpc(rig, "tasks/cancel", { taskId: task.vars.taskId }, TASKS_CAPS)
    expect(ack.status).toBe(200)
    await waitFor(() => rig.projector().get(String(task.vars.taskId), undefined, undefined).status === "cancelled")
    return { vars: task.vars }
  },
  async "task-failed"(rig) {
    const task = await startTask(rig)
    rig.restartTasks()
    return { vars: task.vars }
  },
  async "task-input_required"(rig) {
    const fake = parkingAgent()
    const sessionId = spawn(rig, fake.agent, { permissionHold: true })
    const caps = { ...TASKS_CAPS, elicitation: { form: {} } }
    const created = await rpc(rig, "tools/call", { name: "agent_prompt", arguments: { sessionId, prompt: "write it" } }, caps)
    const taskId = created.json.result?.taskId as string
    await waitFor(() => rig.registry.listPendingPermissions({ sessionId }).length > 0)
    const view = await rpc(rig, "tasks/get", { taskId }, caps)
    const inputKey = Object.keys(view.json.result?.inputRequests ?? {})[0]
    expect(inputKey, "the scenario could not reach input_required").toBeDefined()
    return { vars: { sessionId, taskId, inputKey } }
  },
  async "task-foreign"(rig) {
    const ownerId = spawn(rig, controllableAgent().agent)
    const child = controllableAgent()
    const childId = spawn(rig, child.agent, { parentSessionId: ownerId })
    const outsiderId = spawn(rig, controllableAgent().agent)
    const created = await rpc(rig, "tools/call", { name: "agent_prompt", arguments: { sessionId: childId, prompt: "work" } }, TASKS_CAPS, ownerId)
    const taskId = created.json.result?.taskId as string
    expect(taskId).toBeDefined()
    return { vars: { taskId, ownerId, outsiderId } }
  },
  async skills(rig) {
    // The skill of the Skills extension page, byte for byte ('Reading Skill Content').
    const src = join(rig.work, "src", "code-review")
    mkdirSync(join(src, "references"), { recursive: true })
    writeFileSync(join(src, "SKILL.md"), "---\nname: code-review\ndescription: Review code using the team's checklist.\n---\n\n# Code review\n\nRead `references/checklist.md`, then review the diff.\n")
    writeFileSync(join(src, "references", "checklist.md"), "# Review checklist\n\nCheck correctness, tests, and compatibility.\n")
    await importSkill({ sourcePath: src }, rig.skillPaths)
    return { vars: {} }
  },
}

// ── Request building ───────────────────────────────────────────────────────

function substitute(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === "string" && value.startsWith("$")) {
    const name = value.slice(1)
    if (!(name in vars)) throw new Error(`unknown variable ${value}`)
    return vars[name]
  }
  if (Array.isArray(value)) return value.map(v => substitute(v, vars))
  if (typeof value === "object" && value !== null) {
    const out: Json = {}
    for (const [k, v] of Object.entries(value)) out[String(substitute(k, vars))] = substitute(v, vars)
    return out
  }
  return value
}

function setPath(target: Json, path: string, value: unknown): void {
  const keys = path.split(".")
  let node = target
  for (const key of keys.slice(0, -1)) node = node[key] ??= {}
  node[keys[keys.length - 1]!] = value
}

function requestOf(fixture: Fixture, c: ConformanceCase): { body: Json; fixtureHeaders: Json } {
  if (typeof c.request === "string") {
    const other = sibling(fixture, c.request)
    return { body: structuredClone(other.request ?? other.body), fixtureHeaders: other.headers ?? {} }
  }
  if (c.request) return { body: { jsonrpc: "2.0", id: 1, ...structuredClone(c.request) }, fixtureHeaders: {} }
  return { body: structuredClone(fixture.json.request ?? fixture.json.body), fixtureHeaders: fixture.json.headers ?? {} }
}

function build(fixture: Fixture, c: ConformanceCase, vars: Record<string, unknown>): { body: Json; headers: Record<string, string> } {
  const { body: raw, fixtureHeaders } = requestOf(fixture, c)
  expect(typeof raw?.method, `${fixture.file}: no request to send`).toBe("string")
  const body = substitute(raw, vars) as Json
  body.params ??= {}
  for (const [path, value] of Object.entries(c.set ?? {})) setPath(body, path, substitute(value, vars))
  // The pages omit `_meta` for brevity and say every request MUST carry it.
  const meta: Json = { [META_VERSION]: VERSION, [META_INFO]: { name: "conformance", version: "0.0.1" }, [META_CAPS]: {}, ...(body.params._meta ?? {}) }
  if (c.clientCapabilities) meta[META_CAPS] = c.clientCapabilities
  body.params._meta = { ...meta, ...(c.meta ?? {}) }
  const headers: Record<string, string> = headersFor(body)
  for (const [key, value] of Object.entries(fixtureHeaders)) if (typeof value === "string") headers[key.toLowerCase()] = value
  if (c.meta?.[META_VERSION]) headers["mcp-protocol-version"] = c.meta[META_VERSION]
  for (const [key, value] of Object.entries(c.headers ?? {})) {
    if (value === null) delete headers[key.toLowerCase()]
    else headers[key.toLowerCase()] = value
  }
  return { body, headers }
}

function mutate(body: Json, step: ConformanceCase["mutate"], rig: Rig): void {
  if (step === "tamper-request-state") {
    const parts = String(body.params.requestState).split(".")
    const payload = parts[2]!
    const i = Math.floor(payload.length / 2)
    parts[2] = payload.slice(0, i) + (payload[i] === "A" ? "B" : "A") + payload.slice(i + 1)
    body.params.requestState = parts.join(".")
  } else if (step === "advance-clock") {
    rig.advanceClock(30 * DAY)
  }
}

// ── Assertions ─────────────────────────────────────────────────────────────

function liveKeys(result: Json): string[] {
  return Object.keys(result).filter(k => k !== "_meta")
}

function referenceKeys(fixture: Fixture, ref: string): string[] {
  if (ref === "task") return TASK_KEYS
  const doc = ref === "response" ? fixture.json.response : fixture.json.body
  return Object.keys(doc?.result ?? {})
}

async function check(fixture: Fixture, c: ConformanceCase, reply: Reply, sent: Json, given: Given): Promise<void> {
  const e = c.expect
  const label = `${fixture.file}: ${c.title}`
  // A known defect is the HTTP status alone; it is pinned by its own `it.fails` below, the rest is checked here.
  if (!c.knownDefect) expect(reply.status, label).toBe(e.httpStatus)
  expect(reply.headers.get("content-type"), label).toMatch(/^application\/json/)
  expect(reply.headers.get("mcp-session-id"), label).toBeNull()
  expect(reply.json.id, label).toEqual(sent.id)
  if (e.code !== undefined) {
    expect(reply.json.result, label).toBeUndefined()
    expect(reply.json.error?.code, label).toBe(e.code)
    if (e.errorKeysOf) expect(Object.keys(reply.json.error).sort(), label).toEqual(Object.keys(fixture.json.body.error).sort())
    if (e.errorData) expect(reply.json.error.data, label).toEqual(e.errorData)
    return
  }
  const result = reply.json.result as Json
  expect(reply.json.error, label).toBeUndefined()
  expect(result?.resultType, label).toBe(e.resultType)
  if (e.match) expect(result, label).toMatchObject(e.match)
  for (const key of e.present ?? []) expect(result, `${label}: ${key}`).toHaveProperty(key)
  for (const key of e.absent ?? []) expect(result, `${label}: ${key}`).not.toHaveProperty(key)
  if (e.keysWithin) {
    const allowed = referenceKeys(fixture, e.keysWithin)
    for (const key of liveKeys(result)) expect(allowed, `${label}: unexpected key ${key}`).toContain(key)
  }
  if (e.inputRequestLike) {
    const page = fixture.json.body as Json
    const requests = Object.values(result.inputRequests ?? {}) as Json[]
    expect(requests, label).toHaveLength(1)
    expect(requests[0]!.method, label).toBe(page.method)
    expect(requests[0]!.params.mode, label).toBe(page.params.mode)
    expect(Object.keys(requests[0]!.params).sort(), label).toEqual(Object.keys(page.params).sort())
  }
  if (e.permissionResolved) await waitFor(() => given.permissionResolved?.() === true)
  if (e.skillsEqualPage) expect(result.skills, label).toEqual(fixture.json.response.result.skills)
  if (e.skillEqualsPageEntry) expect(result.skill, label).toEqual(sibling(fixture, "skills-list-request").response.result.skills[0])
  if (e.contentsEqualPage) expect(result.contents, label).toEqual(fixture.json.response.result.contents)
}

// ── Replay ─────────────────────────────────────────────────────────────────

async function replay(fixture: Fixture, c: ConformanceCase): Promise<{ reply: Reply; body: Json; given: Given }> {
  if (c.given) expect(SCENARIOS[c.given], `unknown scenario ${c.given}`).toBeDefined()
  const rig = await startRig()
  const given: Given = c.given ? await SCENARIOS[c.given]!(rig) : { vars: {} }
  const vars = { ...given.vars }
  const { body, headers } = build(fixture, c, vars)
  expect(body.method, "the block names the method it sends").toBe(c.method)
  if (c.mutate) mutate(body, c.mutate, rig)
  let reply!: Reply
  for (let i = 0; i < (c.repeat ?? 1); i++) reply = await post(rig, body, headers, c.caller ? String(substitute(c.caller, vars)) : undefined)
  return { reply, body, given }
}

describe("MCP 2026-07-28 black-box conformance replay over /mcp", () => {
  for (const { fixture, cases } of DISCOVERED.replayed) {
    describe(fixture.file, () => {
      it("names the public page it was read from", () => {
        expect(fixture.json._source).toMatch(/^https:\/\/(modelcontextprotocol\.io|github\.com\/modelcontextprotocol)\//)
      })
      for (const c of cases) {
        it(`[${c.case}] ${c.title}`, async () => {
          const { reply, body, given } = await replay(fixture, c)
          await check(fixture, c, reply, body, given)
        })
        if (c.knownDefect) {
          // Turns red (an unexpected pass) once the code answers the status the block expects: drop `knownDefect` then.
          it.fails(`[known defect] ${c.title}: HTTP ${c.expect.httpStatus} expected. ${c.knownDefect}`, async () => {
            const { reply } = await replay(fixture, c)
            expect(reply.status).toBe(c.expect.httpStatus)
          })
        }
      }
    })
  }

  it(`skips the ${DISCOVERED.ignored.length} fixtures that carry no _conformance block: ${DISCOVERED.ignored.join(", ")}`, () => {
    const total = FIXTURE_DIRS.reduce((n, dir) => n + readdirSync(dir).filter(f => f.endsWith(".json")).length, 0)
    expect(DISCOVERED.replayed.length + DISCOVERED.ignored.length).toBe(total)
    expect(DISCOVERED.replayed.length).toBeGreaterThan(0)
  })

  it("every case names a known scenario, a surface and a polarity", () => {
    for (const { fixture, cases } of DISCOVERED.replayed) {
      for (const c of cases) {
        expect(["positive", "negative"], fixture.file).toContain(c.case)
        expect(typeof c.method, fixture.file).toBe("string")
        expect(c.era, fixture.file).toMatch(/^2026-07-28/)
        expect(typeof c.capability, fixture.file).toBe("string")
        expect(["gateway", "elicitation", "tasks", "skills"], fixture.file).toContain(c.surface)
        if (c.given) expect(Object.keys(SCENARIOS), fixture.file).toContain(c.given)
      }
    }
  })
})
