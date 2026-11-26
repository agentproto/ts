import { afterEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { SessionDescriptor } from "../sessions.js"
import {
  CACHE_HINT_METHODS,
  NAME_HEADER_SOURCE,
  TASKS_EXTENSION,
  clientDeclaresTasks,
  createTaskProjector,
  createTurnTaskLedger,
  handleTaskRequest,
  type TaskSessions,
} from "../mcp-modern/index.js"

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentproto-mcp-tasks-unit-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const DECLARED = { extensions: { [TASKS_EXTENSION]: {} } }

type Desc = Partial<SessionDescriptor> & { id: string }

function fakeSessions(initial: Desc, text = "final answer") {
  const state: { desc: Desc | undefined; interrupted: number; removed: string[]; text: string } = {
    desc: initial,
    interrupted: 0,
    removed: [],
    text,
  }
  const sessions: TaskSessions = {
    get: id => (state.desc && state.desc.id === id ? (state.desc as SessionDescriptor) : undefined),
    readOutputTail: () => [state.text],
    interruptSession: async () => {
      state.interrupted++
      return { wasBusy: true }
    },
    removeQueuedPrompt: (_id, queueId) => {
      state.removed.push(queueId)
      return { removed: true }
    },
  }
  return { sessions, state }
}

const answerOf = (body: Record<string, unknown>) => ({ content: [{ type: "text", text: JSON.stringify(body) }] })

describe("Tasks extension: ledger", () => {
  it("writes entries 0600 in a 0700 directory and rejects ids that are not task handles", () => {
    const dir = join(tempDir(), "ledger")
    const ledger = createTurnTaskLedger({ dir })
    const now = new Date().toISOString()
    ledger.create({
      taskId: `task_${"a".repeat(32)}`,
      sessionId: "sess_x",
      turnSeq: 1,
      bootId: "b",
      createdAt: now,
      ttlMs: 60_000,
      pollIntervalMs: 1000,
      lastStatus: "working",
      lastUpdatedAt: now,
    })
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, `task_${"a".repeat(32)}.json`)).mode & 0o777).toBe(0o600)
    expect(ledger.get(`task_${"a".repeat(32)}`)?.sessionId).toBe("sess_x")
    expect(ledger.get("../../etc/passwd")).toBeUndefined()
    expect(ledger.get("sess_x")).toBeUndefined()
  })

  it("expires an entry past its lifetime (get and sweep both drop it)", () => {
    const dir = tempDir()
    let t = Date.parse("2026-01-01T00:00:00Z")
    const ledger = createTurnTaskLedger({ dir, now: () => t })
    const id = `task_${"b".repeat(32)}`
    ledger.create({
      taskId: id,
      sessionId: "sess_x",
      turnSeq: 1,
      bootId: "b",
      createdAt: new Date(t).toISOString(),
      ttlMs: 1000,
      pollIntervalMs: 100,
      lastStatus: "working",
      lastUpdatedAt: new Date(t).toISOString(),
    })
    expect(ledger.get(id)).toBeDefined()
    t += 2000
    expect(ledger.get(id)).toBeUndefined()
    expect(existsSync(join(dir, `${id}.json`))).toBe(false)
  })
})

describe("Tasks extension: projection of one turn", () => {
  function setup(initial: Desc, opts: { bootId?: string; dir?: string } = {}) {
    const dir = opts.dir ?? tempDir()
    const fake = fakeSessions(initial)
    const projector = createTaskProjector({
      sessions: fake.sessions,
      ledger: createTurnTaskLedger({ dir }),
      ...(opts.bootId ? { bootId: opts.bootId } : {}),
    })
    return { ...fake, projector, dir }
  }

  const create = (s: ReturnType<typeof setup>, promptArgs: Record<string, unknown> = { sessionId: "sess_1", prompt: "go" }) => {
    const plan = s.projector.plan("agent_prompt", { arguments: promptArgs })!
    const made = s.projector.finalize(plan, answerOf({ ok: true, sessionId: "sess_1", queued: true }), undefined)
    return { plan, made, taskId: made.taskId as string }
  }

  it("computes the turn rank before the call: running turn and queued prompts count, an interrupt drops the queue", () => {
    const s = setup({
      id: "sess_1",
      status: "running",
      busy: true,
      turnsCompleted: 2,
      promptQueue: [{ id: "q1" } as never, { id: "q2" } as never],
    })
    expect(s.projector.plan("agent_prompt", { arguments: { sessionId: "sess_1", prompt: "x" } })?.turnSeq).toBe(2 + 1 + 2 + 1)
    expect(
      s.projector.plan("agent_prompt", { arguments: { sessionId: "sess_1", prompt: "x", interrupt: true } })?.turnSeq,
    ).toBe(2 + 1 + 1)
    expect(s.projector.plan("agent_start", { arguments: { prompt: "hello" } })?.turnSeq).toBe(1)
    // no first prompt, no turn, no task
    expect(s.projector.plan("agent_start", { arguments: { adapter: "x" } })).toBeUndefined()
    expect(s.projector.plan("session_list", { arguments: {} })).toBeUndefined()
  })

  it("creates a CreateTaskResult with a 128-bit random handle, durable before the answer", () => {
    const s = setup({ id: "sess_1", status: "running", busy: false, turnsCompleted: 0 })
    const { made, taskId } = create(s)
    expect(made.resultType).toBe("task")
    expect(taskId).toMatch(/^task_[0-9a-f]{32}$/)
    expect(taskId).not.toContain("sess_1")
    expect(made.status).toBe("working")
    expect(typeof made.ttlMs).toBe("number")
    expect(typeof made.pollIntervalMs).toBe("number")
    // the ledger line exists already
    expect(readdirSync(s.dir)).toContain(`${taskId}.json`)
    const got = s.projector.get(taskId, undefined, DECLARED)
    expect(got.taskId).toBe(taskId)
  })

  it("keeps an error answer, a duplicate and a non-turn answer untouched", () => {
    const s = setup({ id: "sess_1", status: "running", busy: false, turnsCompleted: 0 })
    const plan = s.projector.plan("agent_prompt", { arguments: { sessionId: "sess_1", prompt: "go" } })!
    const err = { content: [{ type: "text", text: "boom" }], isError: true }
    expect(s.projector.finalize(plan, err, undefined)).toBe(err)
    const dup = answerOf({ ok: true, sessionId: "sess_1", queued: false, duplicate: true })
    expect(s.projector.finalize(plan, dup, undefined)).toBe(dup)
    expect(readdirSync(s.dir)).toHaveLength(0)
  })

  it("maps the turn states (queued, running, completed, interrupted) and never reports a session-level cancel", () => {
    const s = setup({ id: "sess_1", status: "running", busy: true, turnsCompleted: 0, promptQueue: [] })
    // a second prompt queued behind the running turn
    const first = create(s, { sessionId: "sess_1", prompt: "a" })
    expect(first.plan.turnSeq).toBe(2) // busy turn (1) + this one
    const queued = s.projector.get(first.taskId, undefined, DECLARED)
    expect(queued.status).toBe("working")
    expect(queued.statusMessage).toBe("queued")

    // the running turn ends, this one starts
    s.state.desc = { ...s.state.desc!, turnsCompleted: 1, busy: true, lastTurnReason: "completed" }
    expect(s.projector.get(first.taskId, undefined, DECLARED).status).toBe("working")

    // and finishes while the session stays running
    s.state.desc = { ...s.state.desc!, turnsCompleted: 2, busy: false, lastTurnReason: "completed" }
    const done = s.projector.get(first.taskId, undefined, DECLARED)
    expect(done.status).toBe("completed")
    expect((done.result as { content: Array<{ text: string }> }).content[0]!.text).toBe("final answer")
    expect(s.state.desc!.status).toBe("running")

    // a later turn on the same session leaves the recorded result alone
    s.state.text = "another answer"
    s.state.desc = { ...s.state.desc!, turnsCompleted: 3 }
    const again = s.projector.get(first.taskId, undefined, DECLARED)
    expect((again.result as { content: Array<{ text: string }> }).content[0]!.text).toBe("final answer")
  })

  it("an interrupted turn is cancelled while the session stays running", () => {
    const s = setup({ id: "sess_1", status: "running", busy: false, turnsCompleted: 0 })
    const { taskId } = create(s, { sessionId: "sess_1", prompt: "x" })
    s.state.desc = { ...s.state.desc!, busy: true } // the turn starts, then gets interrupted
    s.state.desc = { ...s.state.desc!, turnsCompleted: 1, busy: false, lastTurnReason: "cancelled" }
    expect(s.projector.get(taskId, undefined, DECLARED).status).toBe("cancelled")
    expect(s.state.desc!.status).toBe("running")
  })

  it("a tool error stays completed (failed is reserved for protocol failures)", () => {
    const s = setup({ id: "sess_1", status: "running", busy: false, turnsCompleted: 0 })
    const { taskId } = create(s)
    s.state.desc = { ...s.state.desc!, turnsCompleted: 1, lastTurnReason: "error" }
    const got = s.projector.get(taskId, undefined, DECLARED)
    expect(got.status).toBe("completed")
    expect((got.result as { isError?: boolean }).isError).toBe(true)
    expect(got).not.toHaveProperty("error")
  })

  it("an abnormal session end is failed with the session id; an operator kill is cancelled", () => {
    const a = setup({ id: "sess_1", status: "running", busy: true, turnsCompleted: 0 })
    const ta = create(a).taskId
    a.state.desc = { ...a.state.desc!, status: "error", busy: false, endedReason: "crashed" }
    const failed = a.projector.get(ta, undefined, DECLARED)
    expect(failed.status).toBe("failed")
    expect((failed.error as { code: number; data: { sessionId: string } }).code).toBe(-32603)
    expect((failed.error as { data: { sessionId: string } }).data.sessionId).toBe("sess_1")

    const b = setup({ id: "sess_1", status: "running", busy: true, turnsCompleted: 0 })
    const tb = create(b).taskId
    b.state.desc = { ...b.state.desc!, status: "killed", busy: false, endedReason: "operator-stopped" }
    expect(b.projector.get(tb, undefined, DECLARED).status).toBe("cancelled")
  })

  it("a daemon restart is failed (not cancelled) and the task still resolves from the ledger", () => {
    const dir = tempDir()
    const before = setup({ id: "sess_1", status: "running", busy: true, turnsCompleted: 0 }, { dir, bootId: "boot-1" })
    const { taskId } = create(before)

    // New daemon: same ledger directory, the session was killed at boot.
    const after = setup(
      { id: "sess_1", status: "killed", busy: false, turnsCompleted: 0, endedReason: "daemon-restart" },
      { dir, bootId: "boot-2" },
    )
    const got = after.projector.get(taskId, undefined, DECLARED)
    expect(got.status).toBe("failed")
    expect((got.error as { data: { endedReason: string } }).data.endedReason).toBe("daemon-restart")

    // Same, when the session came back idle (lazy resume) without having rerun the turn.
    const dir2 = tempDir()
    const b1 = setup({ id: "sess_1", status: "running", busy: true, turnsCompleted: 0 }, { dir: dir2, bootId: "boot-1" })
    const t2 = create(b1).taskId
    const b2 = setup({ id: "sess_1", status: "running", busy: false, turnsCompleted: 0 }, { dir: dir2, bootId: "boot-2" })
    expect(b2.projector.get(t2, undefined, DECLARED).status).toBe("failed")
  })

  it("tasks/get is pure: two reads are identical and write nothing once settled", () => {
    const s = setup({ id: "sess_1", status: "running", busy: true, turnsCompleted: 0 })
    const { taskId } = create(s)
    const a = s.projector.get(taskId, undefined, DECLARED)
    const b = s.projector.get(taskId, undefined, DECLARED)
    expect(b).toEqual(a)
    expect(a.resultType).toBe("complete")
    // no cache hints: ttlMs is the task lifetime, and tasks/get is not a cacheable operation
    expect(a).not.toHaveProperty("cacheScope")
    expect(CACHE_HINT_METHODS.has("tasks/get")).toBe(false)
    expect(a.lastUpdatedAt).toBe(b.lastUpdatedAt)
    expect(NAME_HEADER_SOURCE.get("tasks/get")).toBe("taskId")
    expect(NAME_HEADER_SOURCE.get("tasks/update")).toBe("taskId")
    expect(NAME_HEADER_SOURCE.get("tasks/cancel")).toBe("taskId")
  })

  it("lastUpdatedAt moves forward only when the state changes", () => {
    let t = Date.parse("2026-02-01T00:00:00Z")
    const dir = tempDir()
    const fake = fakeSessions({ id: "sess_1", status: "running", busy: true, turnsCompleted: 0 })
    const projector = createTaskProjector({
      sessions: fake.sessions,
      ledger: createTurnTaskLedger({ dir, now: () => t }),
      now: () => t,
    })
    const plan = projector.plan("agent_prompt", { arguments: { sessionId: "sess_1", prompt: "x" } })!
    const taskId = projector.finalize(plan, answerOf({ ok: true, sessionId: "sess_1" }), undefined).taskId as string
    const first = projector.get(taskId, undefined, DECLARED).lastUpdatedAt as string
    t += 5000
    expect(projector.get(taskId, undefined, DECLARED).lastUpdatedAt).toBe(first)
    fake.state.desc = { ...fake.state.desc!, turnsCompleted: 2, busy: false, lastTurnReason: "completed" }
    const done = projector.get(taskId, undefined, DECLARED).lastUpdatedAt as string
    expect(Date.parse(done)).toBeGreaterThan(Date.parse(first))
  })

  it("scopes a task to its owner and to ancestors of the session; others see an unknown id", () => {
    const s = setup({ id: "sess_1", status: "running", busy: true, turnsCompleted: 0, parentSessionId: "sess_parent" })
    const plan = s.projector.plan("agent_prompt", { arguments: { sessionId: "sess_1", prompt: "x" } })!
    const { taskId } = { taskId: s.projector.finalize(plan, answerOf({ ok: true, sessionId: "sess_1" }), "sess_owner").taskId as string }
    // the owner and the operator read it
    expect(s.projector.get(taskId, "sess_owner", DECLARED).taskId).toBe(taskId)
    expect(s.projector.get(taskId, undefined, DECLARED).taskId).toBe(taskId)
    // an unrelated session that merely knows the handle does not
    expect(() => s.projector.get(taskId, "sess_outsider", DECLARED)).toThrow(/Unknown or expired/)
    expect(() => s.projector.get(`task_${"0".repeat(32)}`, undefined, DECLARED)).toThrow(/Unknown or expired/)
  })

  it("cancels cooperatively: interrupts the running turn, removes only a queued prompt otherwise", async () => {
    const s = setup({ id: "sess_1", status: "running", busy: false, turnsCompleted: 0 })
    const running = s.projector.plan("agent_prompt", { arguments: { sessionId: "sess_1", prompt: "x" } })!
    const runningId = s.projector.finalize(running, answerOf({ ok: true, sessionId: "sess_1" }), undefined).taskId as string
    s.state.desc = { ...s.state.desc!, busy: true } // its turn is the one running
    await s.projector.cancel(runningId, undefined)
    expect(s.state.interrupted).toBe(1)

    const queuedPlan = s.projector.plan("agent_prompt", { arguments: { sessionId: "sess_1", prompt: "y" } })!
    const queuedId = s.projector.finalize(
      queuedPlan,
      answerOf({ ok: true, sessionId: "sess_1", queueId: "q-9" }),
      undefined,
    ).taskId as string
    await s.projector.cancel(queuedId, undefined)
    // the running turn belongs to somebody else: it was not interrupted again
    expect(s.state.interrupted).toBe(1)
    expect(s.state.removed).toEqual(["q-9"])
    expect(s.projector.get(queuedId, undefined, DECLARED).status).toBe("cancelled")
  })

  it("an expired or collected-without-result task resolves as unknown", () => {
    const s = setup({ id: "sess_1", status: "running", busy: true, turnsCompleted: 0 })
    const { taskId } = create(s)
    s.state.desc = undefined // session collected, no result recorded
    expect(() => s.projector.get(taskId, undefined, DECLARED)).toThrow(/Unknown or expired/)
  })
})

describe("Tasks extension: request handling", () => {
  const stubProjector = {
    plan: () => undefined,
    finalize: (_p: unknown, a: Record<string, unknown>) => a,
    get: () => ({ resultType: "complete" }),
    update: async () => {},
    cancel: async () => {},
    observeTurnEnd: () => {},
  }

  it("detects the declared extension only as an object under extensions", () => {
    expect(clientDeclaresTasks(DECLARED)).toBe(true)
    expect(clientDeclaresTasks({})).toBe(false)
    expect(clientDeclaresTasks({ extensions: { [TASKS_EXTENSION]: true } })).toBe(false)
    expect(clientDeclaresTasks(undefined)).toBe(false)
  })

  it("answers -32021 with the required extension to a client that did not declare it", async () => {
    await expect(
      handleTaskRequest(stubProjector, { method: "tasks/get", params: { taskId: "task_x" }, clientCapabilities: {} }),
    ).rejects.toMatchObject({
      code: -32021,
      data: { requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } } },
    })
  })

  it("rejects missing params and answers update/cancel with an empty ack", async () => {
    await expect(
      handleTaskRequest(stubProjector, { method: "tasks/get", params: {}, clientCapabilities: DECLARED }),
    ).rejects.toMatchObject({ code: -32602 })
    await expect(
      handleTaskRequest(stubProjector, { method: "tasks/update", params: { taskId: "t" }, clientCapabilities: DECLARED }),
    ).rejects.toMatchObject({ code: -32602 })
    expect(
      await handleTaskRequest(stubProjector, {
        method: "tasks/update",
        params: { taskId: "t", inputResponses: {} },
        clientCapabilities: DECLARED,
      }),
    ).toEqual({ resultType: "complete" })
    expect(
      await handleTaskRequest(stubProjector, { method: "tasks/cancel", params: { taskId: "t" }, clientCapabilities: DECLARED }),
    ).toEqual({ resultType: "complete" })
  })
})
