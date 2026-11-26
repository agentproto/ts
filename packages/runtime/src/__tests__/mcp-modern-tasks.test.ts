import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { PromptTicketEvent, SessionDescriptor, SessionRetiredEvent } from "../sessions.js"
import {
  TASKS_EXTENSION,
  TURN_TASK_META,
  clientDeclaresTasks,
  createTaskProjector,
  createTurnTaskLedger,
  handleTaskRequest,
  mintTaskId,
  principalOf,
  taskToolsForMode,
  type TaskProjector,
  type TaskSessions,
  type TurnTaskLedgerEntry,
} from "../mcp-modern/index.js"
import { currentTurnTaskReservation, runWithTurnTaskReservation } from "../turn-task-context.js"

const DECLARED = { extensions: { [TASKS_EXTENSION]: {} } }

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "agentproto-mcp-tasks-unit-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

/** A registry stand-in whose ticket events and retirements the test fires by hand. */
function fakeSessions() {
  const rows = new Map<string, Partial<SessionDescriptor>>()
  const ticketState = new Map<string, "queued" | "in-flight">()
  const ticketListeners = new Set<(ev: PromptTicketEvent) => void>()
  const retiredListeners = new Set<(ev: SessionRetiredEvent) => void>()
  const cancelled: Array<[string, string]> = []
  let cancelImpl: (id: string, promptId: string) => Promise<{ outcome: "dropped" | "interrupted" | "noop" }> = async () => ({
    outcome: "noop",
  })
  const sessions: TaskSessions = {
    get: id => rows.get(id) as SessionDescriptor | undefined,
    readOutputTail: () => [],
    onPromptTicket: l => {
      ticketListeners.add(l)
      return () => ticketListeners.delete(l)
    },
    onSessionRetired: l => {
      retiredListeners.add(l)
      return () => retiredListeners.delete(l)
    },
    promptTicketState: (_id, promptId) => ticketState.get(promptId) ?? "unknown",
    cancelPromptTicket: async (id, promptId) => {
      cancelled.push([id, promptId])
      return cancelImpl(id, promptId)
    },
  }
  return {
    sessions,
    rows,
    ticketState,
    cancelled,
    setCancel: (fn: typeof cancelImpl) => {
      cancelImpl = fn
    },
    fire: (ev: PromptTicketEvent) => ticketListeners.forEach(l => l(ev)),
    retire: (ev: SessionRetiredEvent) => retiredListeners.forEach(l => l(ev)),
  }
}

function rig(
  opts: {
    now?: () => number
    bootId?: string
    dir?: string
    text?: string
    redact?: (t: string) => string
    max?: number
    cap?: number
    ttlMs?: number
    maxTtlMs?: number
  } = {},
) {
  const dir = opts.dir ?? tmp()
  const fake = fakeSessions()
  const clock = { t: Date.parse("2026-11-26T10:00:00.000Z") }
  const now = opts.now ?? (() => clock.t)
  const ledger = createTurnTaskLedger({ dir, now })
  const projector = createTaskProjector({
    sessions: fake.sessions,
    ledger,
    now,
    ...(opts.bootId ? { bootId: opts.bootId } : {}),
    readFinalText: () => opts.text ?? "final answer",
    ...(opts.redact ? { redact: opts.redact } : {}),
    ...(opts.max ? { resultMaxChars: opts.max } : {}),
    ...(opts.cap ? { maxActivePerPrincipal: opts.cap } : {}),
    ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}),
    ...(opts.maxTtlMs ? { maxTtlMs: opts.maxTtlMs } : {}),
  })
  return { ...fake, dir, ledger, projector, clock }
}

/** Drive a covered call the way the gateway does: plan, tool commits, finalize. */
function create(r: ReturnType<typeof rig>, tool: "agent_prompt" | "agent_start", caller?: string, sessionId = "sess_target") {
  const plan = r.projector.plan(
    tool,
    { name: tool, arguments: tool === "agent_start" ? { prompt: "go" } : { sessionId, prompt: "go" } },
    caller,
  )
  if (!plan || plan.kind !== "reserved") throw new Error("expected a reservation")
  const target = plan.reservation.sessionId ?? sessionId
  plan.reservation.commit(target)
  const body = tool === "agent_start" ? { id: target } : { ok: true, sessionId: target, delivery: "queued-mid-turn" }
  const answer = r.projector.finalize(plan, { content: [{ type: "text", text: JSON.stringify(body) }] })
  return { plan, answer, taskId: answer.taskId as string, promptId: plan.reservation.promptId, sessionId: target }
}

const ENTRY = (over: Partial<TurnTaskLedgerEntry> = {}): TurnTaskLedgerEntry => ({
  taskId: mintTaskId(),
  sessionId: "sess_a",
  promptId: "prompt_a",
  principal: "operator",
  bootId: "b",
  createdAt: "2026-11-26T10:00:00.000Z",
  ttlMs: 1000,
  pollIntervalMs: 10,
  lastStatus: "working",
  lastUpdatedAt: "2026-11-26T10:00:00.000Z",
  started: false,
  ...over,
})

describe("turn-task ledger (AIP-78 §Task identity, ledger and ownership)", () => {
  it("writes atomically, fsynced, mode 0600, leaving no temporary file, and survives a reload", () => {
    const dir = tmp()
    const a = createTurnTaskLedger({ dir })
    const e = ENTRY()
    a.create(e)
    const files = readdirSync(dir)
    expect(files).toEqual([`${e.taskId}.json`])
    expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(join(dir, files[0]!), "utf8")).promptId).toBe("prompt_a")
    // a new ledger on the same directory (a restart) resolves the entry
    expect(createTurnTaskLedger({ dir }).get(e.taskId)).toMatchObject({ sessionId: "sess_a", principal: "operator" })
  })

  it("discards a temporary file left by an interrupted write and ignores corrupt entries", () => {
    const dir = tmp()
    const e = ENTRY()
    writeFileSync(join(dir, `${e.taskId}.json.1.0.tmp`), "{half")
    writeFileSync(join(dir, `task_${"a".repeat(32)}.json`), "not json")
    const ledger = createTurnTaskLedger({ dir })
    expect(readdirSync(dir)).toEqual([`task_${"a".repeat(32)}.json`])
    expect(ledger.list()).toEqual([])
  })

  it("counts ttlMs from endedAt, never purges a non-terminal entry, and drops only expired terminal ones", () => {
    const dir = tmp()
    let t = Date.parse("2026-11-26T10:00:00.000Z")
    const ledger = createTurnTaskLedger({ dir, now: () => t })
    const open = ENTRY({ ttlMs: 1000 })
    const done = ENTRY({ ttlMs: 1000, lastStatus: "completed", endedAt: "2026-11-26T10:00:05.000Z" })
    ledger.create(open)
    ledger.create(done)
    // created long ago but ended 5 s after: retention runs from the end
    t = Date.parse("2026-11-26T10:00:05.900Z")
    expect(ledger.sweep()).toEqual([])
    t = Date.parse("2026-11-26T10:00:06.000Z")
    expect(ledger.sweep()).toEqual([done.taskId])
    expect(ledger.get(done.taskId)).toBeUndefined()
    // a non-terminal entry survives any amount of time
    t = Date.parse("2030-01-01T00:00:00.000Z")
    expect(ledger.sweep()).toEqual([])
    expect(ledger.get(open.taskId)).toBeDefined()
  })

  it("counts the non-terminal entries of one principal", () => {
    const ledger = createTurnTaskLedger({ dir: tmp() })
    ledger.create(ENTRY({ principal: "session:s1" }))
    ledger.create(ENTRY({ principal: "session:s1" }))
    ledger.create(ENTRY({ principal: "session:s1", lastStatus: "failed", endedAt: "2026-11-26T10:00:00.000Z" }))
    ledger.create(ENTRY({ principal: "session:s2" }))
    expect(ledger.countActive("session:s1")).toBe(2)
    expect(ledger.countActive("operator")).toBe(0)
  })
})

describe("turn-task creation (AIP-78 §Order of operations)", () => {
  it("reserves the ticket and, for agent_start, the session id; nothing is on disk until the tool commits", () => {
    const r = rig()
    const plan = r.projector.plan("agent_start", { name: "agent_start", arguments: { prompt: "go" } }, undefined)
    expect(plan?.kind).toBe("reserved")
    if (plan?.kind !== "reserved") return
    expect(plan.reservation.sessionId).toMatch(/^sess_/)
    expect(plan.reservation.promptId).toMatch(/^prompt_[0-9a-f]{16}$/)
    expect(plan.taskId).toMatch(/^task_[0-9a-f]{32}$/)
    expect(plan.taskId).not.toContain(plan.reservation.sessionId!.slice(5))
    expect(readdirSync(r.dir)).toEqual([])
    plan.reservation.commit(plan.reservation.sessionId!)
    plan.reservation.commit(plan.reservation.sessionId!) // idempotent
    const entries = r.ledger.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      sessionId: plan.reservation.sessionId,
      promptId: plan.reservation.promptId,
      lastStatus: "working",
      statusMessage: "queued",
      principal: "operator",
      started: false,
    })
  })

  it("agent_prompt reserves only a ticket (the tool names the session when it commits)", () => {
    const r = rig()
    const plan = r.projector.plan("agent_prompt", { name: "agent_prompt", arguments: { sessionId: "sess_x", prompt: "hi" } }, "sess_boss")
    expect(plan).toMatchObject({ kind: "reserved" })
    if (plan?.kind !== "reserved") return
    expect(plan.reservation.sessionId).toBeUndefined()
    plan.reservation.commit("sess_x")
    expect(r.ledger.list()[0]).toMatchObject({ principal: "session:sess_boss", sessionId: "sess_x" })
  })

  it("covers only agent_start WITH a prompt and agent_prompt, per the configured mode", () => {
    const r = rig()
    expect(r.projector.plan("agent_start", { name: "agent_start", arguments: {} }, undefined)).toBeUndefined()
    expect(r.projector.plan("agent_start", { name: "agent_start", arguments: { prompt: "  " } }, undefined)).toBeUndefined()
    expect(r.projector.plan("agent_kill", { name: "agent_kill", arguments: { sessionId: "x" } }, undefined)).toBeUndefined()
    expect(taskToolsForMode("agent_start")).toEqual(new Set(["agent_start"]))
    r.projector.configure({ tools: "agent_prompt" })
    expect(r.projector.plan("agent_start", { name: "agent_start", arguments: { prompt: "go" } }, undefined)).toBeUndefined()
    expect(
      r.projector.plan("agent_prompt", { name: "agent_prompt", arguments: { sessionId: "x", prompt: "go" } }, undefined)?.kind,
    ).toBe("reserved")
    r.projector.configure({ tools: "agent_start" })
    expect(r.projector.plan("agent_prompt", { name: "agent_prompt", arguments: { sessionId: "x", prompt: "go" } }, undefined)).toBeUndefined()
  })

  it("refuses beyond the per-principal cap before any ticket or ledger entry exists", () => {
    const r = rig({ cap: 2 })
    create(r, "agent_prompt", "sess_boss")
    create(r, "agent_prompt", "sess_boss")
    const call = { name: "agent_prompt", arguments: { sessionId: "sess_x", prompt: "go" } }
    const refused = r.projector.plan("agent_prompt", call, "sess_boss")
    expect(refused?.kind).toBe("refused")
    if (refused?.kind === "refused") expect(refused.answer).toMatchObject({ isError: true })
    expect(r.ledger.list()).toHaveLength(2)
    // another principal is not affected, and the cap frees up when a task ends
    expect(r.projector.plan("agent_prompt", call, "sess_other")?.kind).toBe("reserved")
    const first = r.ledger.list()[0]!
    r.fire({ type: "dropped", sessionId: first.sessionId, promptId: first.promptId, cause: "removed" })
    expect(r.projector.plan("agent_prompt", call, "sess_boss")?.kind).toBe("reserved")
  })

  it("answers a CreateTaskResult carrying the real session and ticket in _meta", () => {
    const r = rig()
    const c = create(r, "agent_prompt", undefined, "sess_target")
    expect(c.answer).toMatchObject({
      resultType: "task",
      taskId: c.taskId,
      status: "working",
      statusMessage: "queued",
      pollIntervalMs: expect.any(Number),
      ttlMs: expect.any(Number),
      _meta: { [TURN_TASK_META]: { sessionId: "sess_target", promptId: c.promptId } },
    })
  })

  it("closes the entry failed and returns the tool's own error when the tool fails after committing", () => {
    const r = rig()
    const plan = r.projector.plan("agent_prompt", { name: "agent_prompt", arguments: { sessionId: "sess_x", prompt: "go" } }, undefined)
    if (plan?.kind !== "reserved") throw new Error("reservation expected")
    plan.reservation.commit("sess_x")
    const toolError = { isError: true, content: [{ type: "text", text: "agent_prompt: session is dead" }] }
    expect(r.projector.finalize(plan, toolError)).toBe(toolError)
    expect(r.ledger.list()[0]).toMatchObject({ lastStatus: "failed", error: { message: "agent_prompt: session is dead" } })
  })

  it("returns the ordinary answer, and cancels the entry, for a duplicate, a deduplicated spawn and an elicitation round", () => {
    const r = rig()
    const dup = r.projector.plan("agent_prompt", { name: "agent_prompt", arguments: { sessionId: "sess_x", prompt: "go" } }, undefined)
    if (dup?.kind !== "reserved") throw new Error("reservation expected")
    dup.reservation.commit("sess_x")
    const dupAnswer = { content: [{ type: "text", text: JSON.stringify({ ok: true, duplicate: true, delivery: "duplicate" }) }] }
    expect(r.projector.finalize(dup, dupAnswer)).toBe(dupAnswer)

    const start = r.projector.plan("agent_start", { name: "agent_start", arguments: { prompt: "go" } }, undefined)
    if (start?.kind !== "reserved") throw new Error("reservation expected")
    start.reservation.commit(start.reservation.sessionId!)
    const reused = { content: [{ type: "text", text: JSON.stringify({ id: "sess_existing", deduped: true }) }] }
    expect(r.projector.finalize(start, reused)).toBe(reused)

    const input = r.projector.plan("agent_prompt", { name: "agent_prompt", arguments: { sessionId: "sess_x", prompt: "go" } }, undefined)
    if (input?.kind !== "reserved") throw new Error("reservation expected")
    input.reservation.commit("sess_x")
    const parked = { resultType: "input_required", inputRequests: {} }
    expect(r.projector.finalize(input, parked)).toBe(parked)
    expect(r.ledger.list().map(e => e.lastStatus)).toEqual(["cancelled", "cancelled", "cancelled"])
  })

  it("leaves an answer untouched when the tool never reached its commit point", () => {
    const r = rig()
    const plan = r.projector.plan("agent_prompt", { name: "agent_prompt", arguments: { sessionId: "sess_x", prompt: "go" } }, undefined)
    if (plan?.kind !== "reserved") throw new Error("reservation expected")
    const answer = { isError: true, content: [{ type: "text", text: "not your session" }] }
    expect(r.projector.finalize(plan, answer)).toBe(answer)
    expect(r.ledger.list()).toEqual([])
  })

  it("hands the reservation to the tool through the request context only", async () => {
    const r = rig()
    const plan = r.projector.plan("agent_prompt", { name: "agent_prompt", arguments: { sessionId: "sess_x", prompt: "go" } }, undefined)
    if (plan?.kind !== "reserved") throw new Error("reservation expected")
    expect(currentTurnTaskReservation()).toBeUndefined()
    const seen = await runWithTurnTaskReservation(plan.reservation, async () => {
      await Promise.resolve()
      return currentTurnTaskReservation()
    })
    expect(seen).toBe(plan.reservation)
    expect(currentTurnTaskReservation()).toBeUndefined()
  })
})

describe("turn-to-task state mapping (AIP-78)", () => {
  const started = (r: ReturnType<typeof rig>, c: ReturnType<typeof create>) => {
    r.rows.set(c.sessionId, { id: c.sessionId, status: "running" })
    r.ticketState.set(c.promptId, "in-flight")
    r.fire({ type: "started", sessionId: c.sessionId, promptId: c.promptId })
  }
  const view = (r: ReturnType<typeof rig>, taskId: string) => r.projector.get(taskId, undefined, undefined) as Record<string, any>

  it("queued, then in flight, then completed with a bounded TurnResult recorded at the end of the turn", () => {
    const r = rig({ text: "all done" })
    const c = create(r, "agent_prompt")
    r.rows.set(c.sessionId, { id: c.sessionId, status: "running" })
    r.ticketState.set(c.promptId, "queued")
    expect(view(r, c.taskId)).toMatchObject({ status: "working", statusMessage: "queued", resultType: "complete" })
    r.clock.t += 1000
    started(r, c)
    expect(view(r, c.taskId).status).toBe("working")
    expect(view(r, c.taskId).statusMessage).toBeUndefined()
    r.clock.t += 1000
    r.ticketState.delete(c.promptId)
    r.fire({ type: "ended", sessionId: c.sessionId, promptId: c.promptId, interrupted: false, reason: "completed" })
    const done = view(r, c.taskId)
    expect(done).toMatchObject({ status: "completed", result: { sessionId: c.sessionId, text: "all done", truncated: false } })
    expect(r.ledger.get(c.taskId)).toMatchObject({ outcome: "finished", endedAt: expect.any(String) })
  })

  it("a turn whose tool reported an error but ended naturally is completed, not failed", () => {
    const r = rig({ text: "tool said isError" })
    const c = create(r, "agent_prompt")
    started(r, c)
    r.fire({ type: "ended", sessionId: c.sessionId, promptId: c.promptId, interrupted: false, reason: "error" })
    expect(view(r, c.taskId).status).toBe("completed")
  })

  it("bounds the stored text at the host limit, flags truncated, and redacts BEFORE cutting", () => {
    const secret = "sk-live-SECRET-0123456789"
    const r = rig({
      text: `ab ${secret} tail of the answer`,
      max: 8,
      redact: t => t.split(secret).join("<redacted>"),
    })
    const c = create(r, "agent_prompt")
    started(r, c)
    r.fire({ type: "ended", sessionId: c.sessionId, promptId: c.promptId, interrupted: false })
    const done = view(r, c.taskId)
    expect(done.result.truncated).toBe(true)
    expect(done.result.text).toBe("ab <reda")
    expect(JSON.stringify(r.ledger.get(c.taskId))).not.toContain("SECRET")
  })

  it("interrupted and dropped tickets are cancelled and the session is untouched", () => {
    const r = rig()
    const a = create(r, "agent_prompt")
    started(r, a)
    r.fire({ type: "ended", sessionId: a.sessionId, promptId: a.promptId, interrupted: true, reason: "cancelled" })
    expect(view(r, a.taskId).status).toBe("cancelled")
    expect(r.ledger.get(a.taskId)?.outcome).toBe("interrupted")
    const b = create(r, "agent_prompt")
    r.fire({ type: "dropped", sessionId: b.sessionId, promptId: b.promptId, cause: "removed" })
    expect(view(r, b.taskId).status).toBe("cancelled")
    expect(r.ledger.get(b.taskId)?.outcome).toBe("dropped")
  })

  it.each([
    ["session-exited", { status: "exited", exitCode: 3 }, "failed", { reason: "session-exited", exitCode: 3 }],
    ["session-error", { status: "error" }, "failed", { reason: "session-error" }],
    ["session-killed", { status: "killed", endedReason: "operator-stopped" }, "cancelled", undefined],
    ["host-restart", { status: "killed", endedReason: "daemon-restart" }, "failed", { reason: "host-restart" }],
  ] as const)("a turn in flight when the session ends (%s) maps to %s", (outcome, desc, status, data) => {
    const r = rig()
    const c = create(r, "agent_prompt")
    started(r, c)
    r.rows.set(c.sessionId, { id: c.sessionId, ...desc } as Partial<SessionDescriptor>)
    r.projector.observeSessionEnded(c.sessionId)
    const v = view(r, c.taskId)
    expect(v.status).toBe(status)
    expect(r.ledger.get(c.taskId)?.outcome).toBe(outcome)
    if (status === "failed") expect(v.error).toMatchObject({ code: -32603, data: { sessionId: c.sessionId, ...data } })
  })

  it.each([
    ["exited", { status: "exited" }],
    ["error", { status: "error" }],
  ] as const)("a turn that never started when the session is %s is cancelled (no work was done)", (_n, desc) => {
    const r = rig()
    const c = create(r, "agent_prompt")
    r.rows.set(c.sessionId, { id: c.sessionId, ...desc } as Partial<SessionDescriptor>)
    r.projector.observeSessionEnded(c.sessionId)
    expect(view(r, c.taskId).status).toBe("cancelled")
  })

  it("a session forgotten while its ticket is queued is cancelled, in flight is failed (session-forgotten)", () => {
    const r = rig()
    const queued = create(r, "agent_prompt", undefined, "sess_q")
    const running = create(r, "agent_prompt", undefined, "sess_r")
    started(r, running)
    r.retire({ sessionId: "sess_q", cause: "forgotten" })
    r.retire({ sessionId: "sess_r", cause: "forgotten" })
    expect(view(r, queued.taskId).status).toBe("cancelled")
    const failed = view(r, running.taskId)
    expect(failed.status).toBe("failed")
    expect(failed.error.data).toMatchObject({ reason: "session-forgotten", sessionId: "sess_r" })
    // an ended task no longer counts against the cap
    expect(r.ledger.countActive("operator")).toBe(0)
  })

  it("a terminal state is never re-derived (first recorded outcome wins)", () => {
    const r = rig()
    const c = create(r, "agent_prompt")
    started(r, c)
    r.fire({ type: "ended", sessionId: c.sessionId, promptId: c.promptId, interrupted: false })
    const recorded = r.ledger.get(c.taskId)
    r.rows.set(c.sessionId, { id: c.sessionId, status: "killed" })
    r.projector.observeSessionEnded(c.sessionId)
    r.fire({ type: "dropped", sessionId: c.sessionId, promptId: c.promptId, cause: "removed" })
    expect(r.ledger.get(c.taskId)).toEqual(recorded)
    expect(view(r, c.taskId).status).toBe("completed")
  })

  it("host restart: only entries with no recorded terminal state become failed; a recorded task keeps state and result", () => {
    const dir = tmp()
    const first = rig({ dir, bootId: "boot-1", text: "kept result" })
    const done = create(first, "agent_prompt", undefined, "sess_a")
    started(first, done)
    first.fire({ type: "ended", sessionId: "sess_a", promptId: done.promptId, interrupted: false })
    const open = create(first, "agent_prompt", undefined, "sess_b")
    const cancelled = create(first, "agent_prompt", undefined, "sess_c")
    first.fire({ type: "dropped", sessionId: "sess_c", promptId: cancelled.promptId, cause: "removed" })

    const second = rig({ dir, bootId: "boot-2" })
    const get = (id: string) => second.projector.get(id, undefined, undefined) as Record<string, any>
    expect(get(done.taskId)).toMatchObject({ status: "completed", result: { text: "kept result" } })
    expect(get(cancelled.taskId).status).toBe("cancelled")
    const lost = get(open.taskId)
    expect(lost.status).toBe("failed")
    expect(lost.error.data).toMatchObject({ reason: "host-restart" })
    expect(second.ledger.get(open.taskId)?.outcome).toBe("host-restart")
  })

  it("a session resumed after a restart does not revive a failed task", () => {
    const dir = tmp()
    const first = rig({ dir, bootId: "boot-1" })
    const c = create(first, "agent_prompt", undefined, "sess_a")
    const second = rig({ dir, bootId: "boot-2" })
    second.rows.set("sess_a", { id: "sess_a", status: "running" })
    second.ticketState.set(c.promptId, "in-flight")
    second.fire({ type: "started", sessionId: "sess_a", promptId: c.promptId })
    second.fire({ type: "ended", sessionId: "sess_a", promptId: c.promptId, interrupted: false })
    expect((second.projector.get(c.taskId, undefined, undefined) as Record<string, any>).status).toBe("failed")
  })

  it("tasks/get has no observable effect: same answer, same ledger bytes, however often it is read", () => {
    const r = rig()
    const c = create(r, "agent_prompt")
    started(r, c)
    const file = join(r.dir, `${c.taskId}.json`)
    const before = readFileSync(file, "utf8")
    const first = view(r, c.taskId)
    r.clock.t += 5000
    const second = view(r, c.taskId)
    const third = view(r, c.taskId)
    expect(second).toEqual(first)
    expect(third).toEqual(first)
    expect(readFileSync(file, "utf8")).toBe(before)
  })

  it("lastUpdatedAt is monotonic per task even when the clock does not move", () => {
    const r = rig()
    const c = create(r, "agent_prompt")
    const seen: string[] = [r.ledger.get(c.taskId)!.lastUpdatedAt]
    started(r, c)
    seen.push(r.ledger.get(c.taskId)!.lastUpdatedAt)
    r.projector.observeInputChanged(c.sessionId)
    seen.push(r.ledger.get(c.taskId)!.lastUpdatedAt)
    r.fire({ type: "ended", sessionId: c.sessionId, promptId: c.promptId, interrupted: false })
    seen.push(r.ledger.get(c.taskId)!.lastUpdatedAt)
    for (let i = 1; i < seen.length; i++) expect(Date.parse(seen[i]!)).toBeGreaterThan(Date.parse(seen[i - 1]!))
  })
})

describe("retention (AIP-78 §Retention)", () => {
  it("applies the host default, clamped to the host maximum, and never reports null", () => {
    const r = rig({ ttlMs: 10_000_000, maxTtlMs: 5000 })
    expect(create(r, "agent_prompt").answer.ttlMs).toBe(5000)
    expect(create(rig(), "agent_prompt").answer.ttlMs).toBe(24 * 60 * 60 * 1000)
  })

  it("a finished task resolves until ttlMs after ITS END, then answers -32602; an unfinished one is never purged", () => {
    const r = rig({ ttlMs: 60_000 })
    const done = create(r, "agent_prompt", undefined, "sess_a")
    const open = create(r, "agent_prompt", undefined, "sess_b")
    r.rows.set("sess_a", { id: "sess_a", status: "running" })
    r.rows.set("sess_b", { id: "sess_b", status: "running" })
    r.clock.t += 3_600_000 // an hour later the turn finally ends
    r.fire({ type: "started", sessionId: "sess_a", promptId: done.promptId })
    r.clock.t += 10
    r.fire({ type: "ended", sessionId: "sess_a", promptId: done.promptId, interrupted: false })
    r.clock.t += 59_999
    expect((r.projector.get(done.taskId, undefined, undefined) as Record<string, any>).status).toBe("completed")
    r.clock.t += 1
    expect(() => r.projector.get(done.taskId, undefined, undefined)).toThrow(/Unknown or expired/)
    // the unfinished one is over an hour old and still resolves
    expect((r.projector.get(open.taskId, undefined, undefined) as Record<string, any>).status).toBe("working")
  })
})

describe("visibility and methods", () => {
  it("only the creating principal, the operator and a supervising session see a task; anyone else gets -32602 (HTTP 400)", () => {
    const r = rig()
    r.rows.set("sess_target", { id: "sess_target", status: "running", parentSessionId: "sess_boss" })
    r.rows.set("sess_boss", { id: "sess_boss", status: "running" })
    r.rows.set("sess_other", { id: "sess_other", status: "running" })
    const c = create(r, "agent_prompt", "sess_boss")
    expect(r.projector.get(c.taskId, "sess_boss", undefined)).toMatchObject({ taskId: c.taskId })
    expect(r.projector.get(c.taskId, undefined, undefined)).toMatchObject({ taskId: c.taskId })
    const denied = (): unknown => r.projector.get(c.taskId, "sess_other", undefined)
    expect(denied).toThrow(/Unknown or expired/)
    try {
      denied()
    } catch (e) {
      expect(e).toMatchObject({ code: -32602, httpStatus: 400 })
    }
    // identical to a task that does not exist
    expect(() => r.projector.get(mintTaskId(), "sess_other", undefined)).toThrow(/Unknown or expired/)
    expect(principalOf("sess_boss")).toBe("session:sess_boss")
    expect(principalOf(undefined)).toBe("operator")
  })

  it("tasks/cancel acts on the task's own ticket only, and not at all on a terminal task", async () => {
    const r = rig()
    const c = create(r, "agent_prompt", undefined, "sess_a")
    await r.projector.cancel(c.taskId, undefined)
    expect(r.cancelled).toEqual([["sess_a", c.promptId]])
    r.fire({ type: "dropped", sessionId: "sess_a", promptId: c.promptId, cause: "cancelled" })
    await r.projector.cancel(c.taskId, undefined)
    expect(r.cancelled).toHaveLength(1)
  })

  it("a harness that cannot cancel the turn: JSON-RPC error, and the task stays as it was", async () => {
    const r = rig()
    const c = create(r, "agent_prompt", undefined, "sess_a")
    r.rows.set("sess_a", { id: "sess_a", status: "running" })
    r.ticketState.set(c.promptId, "in-flight")
    r.fire({ type: "started", sessionId: "sess_a", promptId: c.promptId })
    r.setCancel(async () => {
      throw new Error("does not support interrupt")
    })
    await expect(r.projector.cancel(c.taskId, undefined)).rejects.toMatchObject({
      code: -32603,
      data: { reason: "cancel-unsupported" },
    })
    expect((r.projector.get(c.taskId, undefined, undefined) as Record<string, any>).status).toBe("working")
  })

  it("serializes cancels on one session: the second starts only after the first settled", async () => {
    const r = rig()
    const a = create(r, "agent_prompt", undefined, "sess_a")
    const b = create(r, "agent_prompt", undefined, "sess_a")
    const order: string[] = []
    let release!: () => void
    r.setCancel(async (_id, promptId) => {
      const name = promptId === a.promptId ? "a" : "b"
      order.push(`start:${name}`)
      if (name === "a") await new Promise<void>(res => (release = res))
      order.push(`end:${name}`)
      return { outcome: "dropped" }
    })
    const pa = r.projector.cancel(a.taskId, undefined)
    const pb = r.projector.cancel(b.taskId, undefined)
    await new Promise(res => setTimeout(res, 20))
    expect(order).toEqual(["start:a"])
    release()
    await Promise.all([pa, pb])
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"])
  })

  it("tasks/update is an acknowledged no-op on a task that is not input_required", async () => {
    const r = rig()
    const apply = vi.fn(async () => {})
    const projector = createTaskProjector({
      sessions: r.sessions,
      ledger: r.ledger,
      humanGate: { inspectPendingForSession: () => undefined, applyResponsesForSession: apply },
    })
    const c = create(r, "agent_prompt", undefined, "sess_a")
    await projector.update(c.taskId, undefined, { k: { action: "accept" } }, undefined)
    expect(apply).not.toHaveBeenCalled()
  })

  it("rejects calls without the declared extension (-32021), a missing taskId and non-object inputResponses (-32602, HTTP 400)", async () => {
    const stub = { get: vi.fn(), update: vi.fn(), cancel: vi.fn() } as unknown as TaskProjector
    await expect(handleTaskRequest(stub, { method: "tasks/get", params: { taskId: "t" }, clientCapabilities: {} })).rejects.toMatchObject({
      code: -32021,
      data: { requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } } },
    })
    await expect(handleTaskRequest(stub, { method: "tasks/get", params: {}, clientCapabilities: DECLARED })).rejects.toMatchObject({
      code: -32602,
      httpStatus: 400,
    })
    await expect(
      handleTaskRequest(stub, { method: "tasks/update", params: { taskId: "t" }, clientCapabilities: DECLARED }),
    ).rejects.toMatchObject({ code: -32602, httpStatus: 400 })
    expect(clientDeclaresTasks(DECLARED)).toBe(true)
    expect(clientDeclaresTasks({ extensions: { [TASKS_EXTENSION]: true } })).toBe(false)
  })
})
