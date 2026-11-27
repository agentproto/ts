/**
 * Prompt tickets: the stable, caller-reserved id of one prompt (`enqueuePrompt`'s `promptId`) and the lifecycle events,
 * state read and single-ticket cancel the MCP task projection (AIP-78) relies on.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSessionsRegistry,
  type AgentSessionLike,
  type PromptTicketEvent,
  type SessionsRegistry,
} from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createTaskProjector, createTurnTaskLedger } from "../mcp-modern/index.js"

type SteerFn = (content: unknown) => Promise<"steered" | "promptRequired" | "unsupported">

/** A fake agent whose turns end only when released (or cancelled). */
function fakeAgent(opts: { steer?: SteerFn; cannotCancel?: boolean } = {}) {
  const gates: Array<(reason: string) => void> = []
  const session: AgentSessionLike = {
    sessionId: "acp",
    pid: 1,
    async *send() {
      const reason = await new Promise<string>(r => gates.push(r))
      yield { kind: "text-delta", text: "done" }
      yield { kind: "turn-end", reason }
    },
    async cancel() {
      if (opts.cannotCancel) throw new Error("cancel is not supported by this harness")
      gates.shift()?.("cancelled")
    },
    async close() {
      gates.shift()?.("cancelled")
    },
    ...(opts.steer ? { steer: opts.steer, steeringSupported: true } : {}),
  }
  return { session, finish: () => gates.shift()?.("completed") }
}

const until = async (pred: () => boolean, ms = 2000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("condition not met in time")
    await new Promise(r => setTimeout(r, 5))
  }
}

describe("prompt tickets", () => {
  let tmp: string
  let registry: SessionsRegistry
  let events: PromptTicketEvent[]
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "prompt-ticket-"))
    registry = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: createSessionEventBus() })
    events = []
    registry.onPromptTicket(ev => events.push(ev))
  })
  afterEach(() => {
    registry.shutdown()
    rmSync(tmp, { recursive: true, force: true })
  })

  const spawn = (agent: { session: AgentSessionLike }) =>
    registry.spawnAgent({ workspaceSlug: "w", cwd: tmp, agentSession: agent.session, adapterSlug: "fake" }).id
  const types = (id: string) => events.filter(e => e.promptId === id).map(e => e.type)

  it("a prompt delivered at once tags its turn: started, in flight, then ended", async () => {
    const agent = fakeAgent()
    const id = spawn(agent)
    await registry.enqueuePrompt(id, "go", { promptId: "prompt_one" })
    await until(() => registry.get(id)?.busy === true)
    expect(registry.promptTicketState(id, "prompt_one")).toBe("in-flight")
    agent.finish()
    await until(() => types("prompt_one").includes("ended"))
    expect(types("prompt_one")).toEqual(["started", "ended"])
    expect(events.find(e => e.type === "ended")).toMatchObject({ interrupted: false })
    expect(registry.promptTicketState(id, "prompt_one")).toBe("unknown")
  })

  it("a parked prompt keeps its ticket as the queue id whatever happens around it, and starts under that ticket", async () => {
    const agent = fakeAgent()
    const id = spawn(agent)
    await registry.enqueuePrompt(id, "first", {})
    await until(() => registry.get(id)?.busy === true)
    const a = await registry.enqueuePrompt(id, "A", { queue: true, promptId: "prompt_a" })
    const b = await registry.enqueuePrompt(id, "B", { queue: true, promptId: "prompt_b" })
    expect([a.queueId, b.queueId]).toEqual(["prompt_a", "prompt_b"])
    expect(registry.promptTicketState(id, "prompt_a")).toBe("queued")
    // reordering and dropping other entries never re-points a ticket
    registry.promoteQueuedPrompt(id, "prompt_b")
    expect(registry.get(id)?.promptQueue?.map(p => p.id)).toEqual(["prompt_b", "prompt_a"])
    expect(registry.removeQueuedPrompt(id, "prompt_a").removed).toBe(true)
    expect(types("prompt_a")).toEqual(["dropped"])
    expect(registry.promptTicketState(id, "prompt_a")).toBe("unknown")
    agent.finish()
    await until(() => types("prompt_b").includes("started"))
    expect(registry.promptTicketState(id, "prompt_b")).toBe("in-flight")
    agent.finish()
    await until(() => types("prompt_b").includes("ended"))
  })

  it("the first prompt of a session reserved before it existed is bound to its first turn", async () => {
    const agent = fakeAgent()
    registry.expectFirstTurnTicket("sess_future", "prompt_first")
    const desc = registry.spawnAgent({ id: "sess_future", workspaceSlug: "w", cwd: tmp, agentSession: agent.session, adapterSlug: "fake" })
    await registry.enqueuePrompt(desc.id, "go", {})
    await until(() => types("prompt_first").includes("started"))
    agent.finish()
    await until(() => types("prompt_first").includes("ended"))
    // consumed: a later turn carries no ticket
    await registry.enqueuePrompt(desc.id, "again", {})
    await until(() => registry.get(desc.id)?.busy === true)
    expect(types("prompt_first")).toEqual(["started", "ended"])
    agent.finish()
  })

  it("a first turn that carries its own ticket drops the reserved one, so the reserved task ends cancelled", async () => {
    const ledger = createTurnTaskLedger({ dir: join(tmp, "tasks") })
    const projector = createTaskProjector({ sessions: registry, ledger })
    const plan = projector.plan("agent_start", { name: "agent_start", arguments: { prompt: "go" } }, undefined)
    if (plan?.kind !== "reserved") throw new Error("expected a reservation")
    const sessionId = plan.reservation.sessionId!
    const reserved = plan.reservation.promptId
    plan.reservation.commit(sessionId)
    registry.expectFirstTurnTicket(sessionId, reserved)
    const agent = fakeAgent()
    registry.spawnAgent({ id: sessionId, workspaceSlug: "w", cwd: tmp, agentSession: agent.session, adapterSlug: "fake" })
    await registry.enqueuePrompt(sessionId, "go", { promptId: "prompt_own" })
    await until(() => types("prompt_own").includes("started"))
    expect(types(reserved)).toEqual(["dropped"])
    expect(ledger.get(plan.taskId)?.lastStatus).toBe("cancelled")
    agent.finish()
    await until(() => types("prompt_own").includes("ended"))
    expect(types(reserved)).toEqual(["dropped"])
  })

  it("releaseFirstTurnTicket frees a reservation whose spawn never happened", async () => {
    const agent = fakeAgent()
    registry.expectFirstTurnTicket("sess_gone", "prompt_x")
    registry.releaseFirstTurnTicket("sess_gone")
    const desc = registry.spawnAgent({ id: "sess_gone", workspaceSlug: "w", cwd: tmp, agentSession: agent.session, adapterSlug: "fake" })
    await registry.enqueuePrompt(desc.id, "go", {})
    await until(() => registry.get(desc.id)?.busy === true)
    expect(types("prompt_x")).toEqual([])
    agent.finish()
  })

  it("cancelPromptTicket: a queued ticket is dropped; the running turn is never touched", async () => {
    const agent = fakeAgent()
    const id = spawn(agent)
    await registry.enqueuePrompt(id, "running", { promptId: "prompt_run" })
    await until(() => registry.get(id)?.busy === true)
    await registry.enqueuePrompt(id, "later", { queue: true, promptId: "prompt_later" })
    expect(await registry.cancelPromptTicket(id, "prompt_later")).toEqual({ outcome: "dropped" })
    expect(registry.get(id)?.busy).toBe(true)
    expect(types("prompt_later")).toEqual(["dropped"])
    expect(await registry.cancelPromptTicket(id, "prompt_later")).toEqual({ outcome: "noop" })
    agent.finish()
  })

  it("cancelPromptTicket: the ticket in flight is interrupted (ended, interrupted) and the session stays alive; an ended ticket is a no-op", async () => {
    const agent = fakeAgent()
    const id = spawn(agent)
    await registry.enqueuePrompt(id, "long", { promptId: "prompt_long" })
    await until(() => registry.get(id)?.busy === true)
    expect(await registry.cancelPromptTicket(id, "prompt_long")).toEqual({ outcome: "interrupted" })
    await until(() => types("prompt_long").includes("ended"))
    expect(events.find(e => e.type === "ended")).toMatchObject({ interrupted: true })
    expect(registry.get(id)?.status).toBe("running")
    // a LATER turn is not the cancelled ticket's turn
    await registry.enqueuePrompt(id, "next", { promptId: "prompt_next" })
    await until(() => registry.get(id)?.busy === true)
    expect(await registry.cancelPromptTicket(id, "prompt_long")).toEqual({ outcome: "noop" })
    expect(registry.get(id)?.busy).toBe(true)
    agent.finish()
  })

  it("cancelPromptTicket rejects when the harness cannot cancel the turn, and the ticket stays in flight", async () => {
    const agent = fakeAgent({ cannotCancel: true })
    const id = spawn(agent)
    await registry.enqueuePrompt(id, "long", { promptId: "prompt_long" })
    await until(() => registry.get(id)?.busy === true)
    await expect(registry.cancelPromptTicket(id, "prompt_long")).rejects.toThrow(/does not support interrupt/)
    expect(registry.promptTicketState(id, "prompt_long")).toBe("in-flight")
    expect(types("prompt_long")).toEqual(["started"])
    agent.finish()
  })

  it("a cancel that lands while the ticket moves from the queue to a turn drops it: it never starts, and the next ticket still runs", async () => {
    const agent = fakeAgent()
    const id = spawn(agent)
    await registry.enqueuePrompt(id, "running", { promptId: "prompt_run" })
    await until(() => registry.get(id)?.busy === true)
    await registry.enqueuePrompt(id, "B", { queue: true, promptId: "prompt_b" })
    await registry.enqueuePrompt(id, "C", { queue: true, promptId: "prompt_c" })
    // the moment the running turn ends, B leaves the queue; cancel it inside that window
    let cancelled: Promise<unknown> | undefined
    registry.onPromptTicket(ev => {
      if (ev.type === "ended" && ev.promptId === "prompt_run") {
        queueMicrotask(() => {
          cancelled = registry.cancelPromptTicket(id, "prompt_b")
        })
      }
    })
    agent.finish()
    await until(() => cancelled !== undefined)
    expect(await cancelled).toEqual({ outcome: "dropped" })
    await until(() => types("prompt_c").includes("started"))
    expect(types("prompt_b")).toEqual(["dropped"]) // dropped, never started
    expect(events.find(e => e.promptId === "prompt_b" && e.type === "dropped")).toMatchObject({ cause: "cancelled" })
    agent.finish()
  })

  it("a prompt steered into the running turn ends with that turn", async () => {
    const agent = fakeAgent({ steer: async () => "steered" })
    const id = spawn(agent)
    await registry.enqueuePrompt(id, "running", { promptId: "prompt_run" })
    await until(() => registry.get(id)?.busy === true)
    const res = await registry.enqueuePrompt(id, "nudge", { queue: true, steer: true, promptId: "prompt_nudge" })
    expect(res.delivery).toBe("steered")
    expect(types("prompt_nudge")).toEqual(["steered"])
    expect(registry.promptTicketState(id, "prompt_nudge")).toBe("in-flight")
    agent.finish()
    await until(() => types("prompt_nudge").includes("ended"))
    expect(types("prompt_run")).toEqual(["started", "ended"])
    expect(registry.promptTicketState(id, "prompt_nudge")).toBe("unknown")
  })

  it("a prompt sent with interrupt:true ends the previous ticket as interrupted and starts its own", async () => {
    const agent = fakeAgent()
    const id = spawn(agent)
    await registry.enqueuePrompt(id, "slow", { promptId: "prompt_old" })
    await until(() => registry.get(id)?.busy === true)
    await registry.enqueuePrompt(id, "urgent", { interrupt: true, promptId: "prompt_new" })
    await until(() => types("prompt_new").includes("started"))
    expect(events.find(e => e.promptId === "prompt_old" && e.type === "ended")).toMatchObject({ interrupted: true })
    expect(registry.promptTicketState(id, "prompt_new")).toBe("in-flight")
    agent.finish()
  })

  it("a prompt without a ticket produces no ticket event", async () => {
    const agent = fakeAgent()
    const id = spawn(agent)
    await registry.enqueuePrompt(id, "plain", {})
    await until(() => registry.get(id)?.busy === true)
    agent.finish()
    await until(() => (registry.get(id)?.turnsCompleted ?? 0) >= 1)
    expect(events).toEqual([])
  })
})
