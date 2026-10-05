/**
 * Prompt delivery honesty + mid-turn steering.
 *
 * Regression: `agent_prompt` to a mid-turn session only QUEUED the message
 * until the end of the target's turn — hours, for a supervisor parked on its
 * children — while the sender believed it was delivered. Now a steering-
 * capable target takes the prompt inside the running turn, the result says
 * `delivered` | `steered` | `queued-mid-turn` + `pending`, and a prompt that
 * stays queued is surfaced (`pendingPrompts`, a notice to the sender) and can
 * be forced through with `deliverWithin`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { registerSessionTools } from "../session-tools.js"
import {
  createSessionsRegistry,
  DEFAULT_PENDING_PROMPT_STALE_MS,
  type AgentSessionLike,
  type SessionsRegistry,
} from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"

type SteerOutcome = "steered" | "promptRequired" | "unsupported"
type SteerFn = (content: unknown) => Promise<SteerOutcome>

/** A fake adapter whose turn stays open until `finishTurn()`; `steer` is only
 *  wired (and advertised) when given — the shape of an ACP agent that
 *  advertises `_meta.steering`. */
function fakeAgent(steer?: SteerFn) {
  const sent: string[] = []
  const gates: Array<() => void> = []
  const session: AgentSessionLike = {
    sessionId: "acp",
    pid: 1,
    async *send(message) {
      const m = message as { text?: string } | string
      sent.push(typeof m === "string" ? m : (m.text ?? ""))
      await new Promise<void>(r => gates.push(r))
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {
      gates.shift()?.()
    },
    async close() {},
    ...(steer ? { steer, steeringSupported: true } : {}),
  }
  return { session, sent, finishTurn: () => gates.shift()?.() }
}

const until = async (pred: () => boolean, ms = 2000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("condition not met in time")
    await new Promise(r => setTimeout(r, 5))
  }
}

describe("enqueuePrompt: mid-turn steering + delivery result", () => {
  let tmp: string
  let registry: SessionsRegistry
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "prompt-steer-"))
    registry = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: createSessionEventBus() })
  })
  afterEach(() => {
    registry.shutdown()
    rmSync(tmp, { recursive: true, force: true })
  })

  const spawn = (steer?: SteerFn, extra: Record<string, unknown> = {}) => {
    const a = fakeAgent(steer)
    const desc = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: "/tmp",
      agentSession: a.session,
      adapterSlug: "mock",
      ...extra,
    })
    return { a, desc }
  }
  const startTurn = async (id: string, a: ReturnType<typeof fakeAgent>) => {
    const first = await registry.enqueuePrompt(id, "work", { queue: true, steer: true })
    expect(first).toMatchObject({ delivery: "delivered", pending: false, queued: false })
    await until(() => a.sent.length === 1)
  }

  it("idle target: delivered now, with deliveredAt", async () => {
    const { desc } = spawn(vi.fn<SteerFn>(async () => "steered"))
    const r = await registry.enqueuePrompt(desc.id, "hello", { queue: true, steer: true })
    expect(r).toMatchObject({ queued: false, delivery: "delivered", pending: false })
    expect(Date.parse(r.deliveredAt!)).not.toBeNaN()
  })

  it("steering target mid-turn: injected into the running turn, never queued, turn undisturbed", async () => {
    const steer = vi.fn<SteerFn>(async () => "steered")
    const { a, desc } = spawn(steer)
    await startTurn(desc.id, a)

    const r = await registry.enqueuePrompt(desc.id, "change course", { queue: true, steer: true, source: "agent:boss" })
    expect(r).toMatchObject({ queued: false, delivery: "steered", pending: false })
    expect(Date.parse(r.deliveredAt!)).not.toBeNaN()
    expect(steer).toHaveBeenCalledTimes(1)
    expect(steer).toHaveBeenCalledWith("change course")
    expect(registry.get(desc.id)?.promptQueue ?? []).toHaveLength(0)
    expect(registry.get(desc.id)?.pendingPrompts).toBeUndefined()
    // The in-flight turn was not cancelled and no second turn started.
    expect(registry.get(desc.id)?.busy).toBe(true)
    a.finishTurn()
    await until(() => registry.get(desc.id)?.busy === false)
    expect(a.sent).toEqual(["work"])
  })

  it("keeps FIFO across a burst of steered prompts", async () => {
    const seen: string[] = []
    const { a, desc } = spawn(async c => {
      await new Promise(r => setTimeout(r, 5))
      seen.push(String(c))
      return "steered"
    })
    await startTurn(desc.id, a)
    const results = await Promise.all(
      ["one", "two", "three"].map(t => registry.enqueuePrompt(desc.id, t, { queue: true, steer: true })),
    )
    expect(results.map(r => r.delivery)).toEqual(["steered", "steered", "steered"])
    expect(seen).toEqual(["one", "two", "three"])
  })

  it("a refused steer leaves it queued (pending) and it runs at turn end", async () => {
    const steer = vi.fn<SteerFn>(async () => "promptRequired")
    const { a, desc } = spawn(steer)
    await startTurn(desc.id, a)
    const r = await registry.enqueuePrompt(desc.id, "later", { queue: true, steer: true })
    expect(r).toMatchObject({ queued: true, delivery: "queued-mid-turn", pending: true })
    expect(r.deliveredAt).toBeUndefined()
    expect(registry.get(desc.id)?.promptQueue).toHaveLength(1)
    a.finishTurn()
    await until(() => a.sent.length === 2)
    expect(a.sent[1]).toBe("later")
  })

  it("no steer flag → queues even on a steering-capable target", async () => {
    const steer = vi.fn<SteerFn>(async () => "steered")
    const { a, desc } = spawn(steer)
    await startTurn(desc.id, a)
    const r = await registry.enqueuePrompt(desc.id, "wait", { queue: true })
    expect(r).toMatchObject({ delivery: "queued-mid-turn", pending: true })
    expect(steer).not.toHaveBeenCalled()
  })

  it("a non-steering adapter queues", async () => {
    const { a, desc } = spawn()
    await startTurn(desc.id, a)
    const r = await registry.enqueuePrompt(desc.id, "wait", { queue: true, steer: true })
    expect(r).toMatchObject({ delivery: "queued-mid-turn", pending: true })
  })

  it("a child's report is never steered", async () => {
    const steer = vi.fn<SteerFn>(async () => "steered")
    const { a, desc } = spawn(steer)
    await startTurn(desc.id, a)
    const r = await registry.enqueuePrompt(desc.id, "report", { queue: true, steer: true, source: "child:sess_x" })
    expect(r.delivery).toBe("queued-mid-turn")
    expect(steer).not.toHaveBeenCalled()
  })

  it("interrupt: true semantics unchanged — cancels the turn and runs the prompt", async () => {
    const steer = vi.fn<SteerFn>(async () => "steered")
    const { a, desc } = spawn(steer)
    await startTurn(desc.id, a)
    const r = await registry.enqueuePrompt(desc.id, "now", { interrupt: true, queue: true, steer: true })
    expect(r).toMatchObject({ queued: false, delivery: "delivered", pending: false })
    expect(steer).not.toHaveBeenCalled()
    await until(() => a.sent.length === 2)
    expect(a.sent[1]).toContain("now")
  })

  it("a turn ending while the steer RPC is in flight does not deliver the prompt twice", async () => {
    let release!: () => void
    const steer = vi.fn<SteerFn>(
      () =>
        new Promise<SteerOutcome>(r => {
          release = () => r("promptRequired")
        }),
    )
    const { a, desc } = spawn(steer)
    await startTurn(desc.id, a)
    const pending = registry.enqueuePrompt(desc.id, "race", { queue: true, steer: true })
    await until(() => steer.mock.calls.length === 1)
    a.finishTurn()
    await until(() => registry.get(desc.id)?.busy === false)
    expect(a.sent).toEqual(["work"]) // drain held off while the steer RPC is in flight
    release()
    const r = await pending
    expect(r.delivery).toBe("delivered")
    await until(() => a.sent.length === 2)
    expect(a.sent.filter(m => m === "race")).toHaveLength(1)
  })

  describe("pendingPrompts + staleness", () => {
    it("get()/list() expose queued prompts with age, flagged stale past the threshold", async () => {
      const { a, desc } = spawn()
      await startTurn(desc.id, a)
      await registry.enqueuePrompt(desc.id, "stuck one", { queue: true, origin: "user" })
      const pp = registry.get(desc.id)?.pendingPrompts
      expect(pp).toHaveLength(1)
      expect(pp![0]).toMatchObject({ origin: "user", preview: "stuck one" })
      expect(pp![0]!.stale).toBeUndefined()
      expect(pp![0]!.ageMs).toBeGreaterThanOrEqual(0)

      const later = Date.now() + DEFAULT_PENDING_PROMPT_STALE_MS + 1000
      vi.useFakeTimers({ now: later, toFake: ["Date"] })
      try {
        expect(registry.get(desc.id)?.pendingPrompts?.[0]).toMatchObject({ stale: true })
        expect(registry.get(desc.id)?.pendingPrompts?.[0]!.ageMs).toBeGreaterThanOrEqual(DEFAULT_PENDING_PROMPT_STALE_MS)
      } finally {
        vi.useRealTimers()
      }
    })

    it("sweep notifies the calling session's inbox once when a prompt is stale", async () => {
      const boss = spawn(undefined, { label: "boss" })
      await startTurn(boss.desc.id, boss.a)
      const { a, desc } = spawn(undefined, { label: "worker", parentSessionId: boss.desc.id, depth: 1 })
      await startTurn(desc.id, a)
      await registry.enqueuePrompt(desc.id, "do the thing", { queue: true, source: `agent:${boss.desc.id}` })

      expect(await registry.sweepPendingPrompts({ staleMs: 60_000 })).toMatchObject({ stale: 0 })
      const now = Date.now() + 61_000
      expect(await registry.sweepPendingPrompts({ now, staleMs: 60_000 })).toMatchObject({ stale: 1 })
      const inbox = registry.listInbox(boss.desc.id) ?? []
      expect(inbox).toHaveLength(1)
      expect(inbox[0]).toMatchObject({ kind: "notice", from: { relation: "system" } })
      expect(inbox[0]!.text).toContain(desc.id)
      expect(inbox[0]!.text).toContain("NOT been delivered")
      // Once per item.
      expect(await registry.sweepPendingPrompts({ now: now + 1000, staleMs: 60_000 })).toMatchObject({ stale: 0 })
      expect(registry.listInbox(boss.desc.id)).toHaveLength(1)
    })

    it("a human-sent stale prompt notifies the target's parent", async () => {
      const boss = spawn(undefined, { label: "boss" })
      await startTurn(boss.desc.id, boss.a)
      const { a, desc } = spawn(undefined, { parentSessionId: boss.desc.id, depth: 1 })
      await startTurn(desc.id, a)
      await registry.enqueuePrompt(desc.id, "from a human", { queue: true, origin: "user" })
      await registry.sweepPendingPrompts({ now: Date.now() + 120_000, staleMs: 60_000 })
      expect(registry.listInbox(boss.desc.id)).toHaveLength(1)
    })
  })

  describe("deliverWithin", () => {
    it("auto: steers once the adapter accepts it", async () => {
      let accept = false
      const steer = vi.fn<SteerFn>(async () => (accept ? "steered" : "promptRequired"))
      const { a, desc } = spawn(steer)
      await startTurn(desc.id, a)
      const r = await registry.enqueuePrompt(desc.id, "soon", { queue: true, deliverWithinMs: 30_000 })
      expect(r.delivery).toBe("queued-mid-turn")
      expect(registry.get(desc.id)?.pendingPrompts?.[0]?.deliverBy).toBeDefined()

      expect(await registry.sweepPendingPrompts({ now: Date.now() + 1000 })).toMatchObject({ forced: 0 })
      accept = true
      expect(await registry.sweepPendingPrompts({ now: Date.now() + 31_000 })).toMatchObject({ forced: 1 })
      expect(steer).toHaveBeenLastCalledWith("soon")
      expect(registry.get(desc.id)?.promptQueue ?? []).toHaveLength(0)
      expect(registry.get(desc.id)?.busy).toBe(true)
    })

    it("auto on a non-steering adapter interrupts the turn and runs the prompt", async () => {
      const { a, desc } = spawn()
      await startTurn(desc.id, a)
      await registry.enqueuePrompt(desc.id, "or else", { queue: true, deliverWithinMs: 1_000 })
      expect(await registry.sweepPendingPrompts({ now: Date.now() + 2_000 })).toMatchObject({ forced: 1 })
      await until(() => a.sent.length === 2)
      expect(a.sent[1]).toContain("or else")
    })

    it("via steer never interrupts: stays queued when the adapter can't steer", async () => {
      const { a, desc } = spawn()
      await startTurn(desc.id, a)
      await registry.enqueuePrompt(desc.id, "gentle", { queue: true, deliverWithinMs: 1_000, deliverVia: "steer" })
      expect(await registry.sweepPendingPrompts({ now: Date.now() + 2_000 })).toMatchObject({ forced: 0 })
      expect(registry.get(desc.id)?.promptQueue).toHaveLength(1)
      expect(a.sent).toEqual(["work"])
    })

    it("via interrupt cuts the turn even on a steering adapter", async () => {
      const steer = vi.fn<SteerFn>(async () => "steered")
      const { a, desc } = spawn(steer)
      await startTurn(desc.id, a)
      await registry.enqueuePrompt(desc.id, "cut", { queue: true, deliverWithinMs: 1_000, deliverVia: "interrupt" })
      await registry.sweepPendingPrompts({ now: Date.now() + 2_000 })
      expect(steer).not.toHaveBeenCalled()
      await until(() => a.sent.length === 2)
      expect(a.sent[1]).toContain("cut")
    })
  })
})

describe("agent_prompt (MCP) end to end with a steering-capable adapter", () => {
  let registry: SessionsRegistry
  let client: Client
  beforeEach(async () => {
    registry = createSessionsRegistry({ persist: false })
    const server = new McpServer({ name: "steer-e2e", version: "0" })
    registerSessionTools(server, { registry, workspace: tmpdir() })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    client = new Client({ name: "steer-e2e-client", version: "0" })
    await client.connect(ct)
  })
  afterEach(async () => {
    await client.close()
    registry.shutdown()
  })

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }
    return JSON.parse(res.content[0]!.text) as Record<string, any>
  }

  it("a mid-turn prompt is steered (delivery:steered, pending:false) and a stuck one is surfaced", async () => {
    const steerable = fakeAgent(async () => "steered")
    const plain = fakeAgent()
    const s1 = registry.spawnAgent({ workspaceSlug: "w", cwd: "/tmp", agentSession: steerable.session, adapterSlug: "claude-code" })
    const s2 = registry.spawnAgent({ workspaceSlug: "w", cwd: "/tmp", agentSession: plain.session, adapterSlug: "other" })

    for (const s of [s1, s2]) {
      const first = await call("agent_prompt", { sessionId: s.id, prompt: "long work" })
      expect(first).toMatchObject({ pending: false, delivery: "delivered", queued: true })
    }
    await until(() => steerable.sent.length === 1 && plain.sent.length === 1)

    // Steering-capable: injected now.
    const steered = await call("agent_prompt", { sessionId: s1.id, prompt: "human says stop" })
    expect(steered).toMatchObject({ ok: true, pending: false, delivery: "steered", queued: true })
    expect(typeof steered.deliveredAt).toBe("string")
    expect(steered.hint).toBeUndefined()
    expect(Object.keys(steered).slice(0, 3)).toEqual(["ok", "pending", "delivery"])

    // `steer: false` opts out.
    const optedOut = await call("agent_prompt", { sessionId: s1.id, prompt: "queue me", steer: false })
    expect(optedOut).toMatchObject({ pending: true, delivery: "queued-mid-turn" })

    // Non-steering: queued, loudly pending, hinted.
    const queued = await call("agent_prompt", { sessionId: s2.id, prompt: "stuck", deliverWithin: 600 })
    expect(queued).toMatchObject({ pending: true, delivery: "queued-mid-turn", queued: true })
    expect(queued.queueId).toMatch(/^q_/)
    expect(queued.hint).toContain("NOT delivered yet")

    // The sender can see it in session_list / session_recap.
    const list = await call("session_list", {})
    const row = (list.sessions as Array<Record<string, any>>).find(r => r.id === s2.id)!
    expect(row.pendingPrompts).toHaveLength(1)
    expect(row.pendingPrompts[0]).toMatchObject({ id: queued.queueId, preview: "stuck" })
    expect(typeof row.pendingPrompts[0].ageMs).toBe("number")
    expect((list.sessions as Array<Record<string, any>>).find(r => r.id === s1.id)!.steering).toBe(true)
    const recap = await call("session_recap", { id: s2.id })
    expect(recap.pendingPrompts).toHaveLength(1)

    steerable.finishTurn()
    plain.finishTurn()
  })
})
