/**
 * Urgency tiers (AIP-46 §Delivery tiers) — `registry.sendMessage` routing
 * across recipient state (idle / busy on a prompted turn / busy on an
 * autonomous turn / parked in inbox_wait) × tier (fyi / next-turn / steer /
 * interrupt, granted or not) × whether the recipient's agent can steer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSessionsRegistry,
  STEER_MIN_INTERVAL_MS,
  type AgentSessionLike,
  type AgentStreamEvent,
  type SessionsRegistry,
} from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createSessionMessage, MESSAGE_PREAMBLE, type MessageUrgency } from "../session-message.js"
import { sessionEventsPath } from "../transcript-writer.js"

type SteerFn = (content: unknown) => Promise<"steered" | "promptRequired" | "unsupported">

function agent(opts: { steer?: SteerFn }) {
  const sent: string[] = []
  const pending: Array<() => void> = []
  let outOfTurn: ((e: AgentStreamEvent) => void) | undefined
  const session: AgentSessionLike = {
    sessionId: "acp",
    pid: 1,
    async *send(message) {
      const m = message as { text?: string } | string
      sent.push(typeof m === "string" ? m : (m.text ?? ""))
      await new Promise<void>(r => pending.push(r))
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {
      pending.shift()?.()
    },
    async close() {},
    onOutOfTurnEvent(listener) {
      outOfTurn = listener
      return () => {
        outOfTurn = undefined
      }
    },
    ...(opts.steer ? { steer: opts.steer, steeringSupported: true } : {}),
  }
  return {
    session,
    sent,
    finishTurn: () => pending.shift()?.(),
    emitOutOfTurn: (e: AgentStreamEvent) => outOfTurn?.(e),
  }
}

async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("condition not met in time")
    await new Promise(r => setTimeout(r, 10))
  }
}

describe("sendMessage tier routing", () => {
  let tmp: string
  let registry: SessionsRegistry
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tiers-"))
    registry = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: createSessionEventBus() })
  })
  afterEach(() => {
    registry.shutdown()
    rmSync(tmp, { recursive: true, force: true })
  })

  const setup = (steer?: SteerFn) => {
    const parentAgent = agent({ ...(steer ? { steer } : {}) })
    const parent = registry.spawnAgent({ workspaceSlug: "w", cwd: "/tmp", agentSession: parentAgent.session, adapterSlug: "mock" })
    const child = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: "/tmp",
      agentSession: agent({}).session,
      adapterSlug: "mock",
      label: "kid",
      parentSessionId: parent.id,
      depth: 1,
    })
    const msg = (urgency: MessageUrgency, text = `msg ${urgency}`) =>
      createSessionMessage({
        to: parent.id,
        from: { sessionId: child.id, label: "kid", relation: "child" },
        text,
        kind: "blocker",
        urgency,
      })
    return { parent, parentAgent, msg }
  }
  const steerRecords = (id: string) => {
    const p = sessionEventsPath(id, tmp)
    if (!existsSync(p)) return []
    return readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(l => JSON.parse(l) as { kind: string; message?: { id: string; delivered?: { via: string } } })
      .filter(r => r.kind === "session-message")
  }

  describe("idle recipient", () => {
    it.each([
      ["next-turn", false, "next-turn"],
      ["steer", false, "steer"],
      ["interrupt", true, "interrupt"],
      ["interrupt", false, "steer"],
    ] as const)("%s (granted=%s) starts its own turn now → applied %s", async (urgency, allowInterrupt, applied) => {
      const steer = vi.fn<SteerFn>(async () => "steered")
      const { parentAgent, msg } = setup(steer)
      const r = await registry.sendMessage(msg(urgency), { allowInterrupt })
      expect(r).toMatchObject({ delivered: { via: "turn" }, queued: false, urgencyApplied: applied })
      await until(() => parentAgent.sent.length === 1)
      expect(parentAgent.sent[0]).toContain(`kind="blocker"`)
      expect(steer).not.toHaveBeenCalled()
    })

    it("fyi never wakes it", async () => {
      const { parent, parentAgent, msg } = setup()
      const r = await registry.sendMessage(msg("fyi"))
      expect(r).toMatchObject({ delivered: { via: "inbox" }, urgencyApplied: "fyi" })
      await new Promise(r => setTimeout(r, 30))
      expect(parentAgent.sent).toEqual([])
      expect(registry.listInbox(parent.id)).toHaveLength(1)
    })
  })

  describe("busy recipient (daemon-prompted turn)", () => {
    it("steer + steering agent → injected into the running turn: not queued, not in the inbox, recorded via steer", async () => {
      const steer = vi.fn<SteerFn>(async () => "steered")
      const { parent, msg } = setup(steer)
      await registry.enqueuePrompt(parent.id, "long work", {})
      const m = msg("steer", "need a decision")
      const r = await registry.sendMessage(m)
      expect(r).toEqual({ messageId: m.id, delivered: { via: "steer" }, queued: false, urgencyApplied: "steer" })
      expect(steer).toHaveBeenCalledTimes(1)
      const content = steer.mock.calls[0]![0] as string
      // First message this session ever receives → preamble taught once.
      expect(content.startsWith(MESSAGE_PREAMBLE)).toBe(true)
      expect(content).toContain(`<agentproto-message id="${m.id}" from="child"`)
      expect(content).toContain("<body>\nneed a decision\n</body>")
      expect(registry.get(parent.id)?.promptQueue ?? []).toEqual([])
      expect(registry.listInbox(parent.id)).toEqual([])
      await until(() => steerRecords(parent.id).length === 1)
      expect(steerRecords(parent.id)[0]!.message).toMatchObject({ id: m.id, delivered: { via: "steer" } })
      expect(registry.get(parent.id)?.messagePreambleSent).toBe(true)
    })

    it("un-granted interrupt → steered instead (never cancels the turn)", async () => {
      const steer = vi.fn<SteerFn>(async () => "steered")
      const { parent, parentAgent, msg } = setup(steer)
      const cancel = vi.spyOn(parentAgent.session, "cancel")
      await registry.enqueuePrompt(parent.id, "long work", {})
      const r = await registry.sendMessage(msg("interrupt"))
      expect(r).toMatchObject({ delivered: { via: "steer" }, urgencyApplied: "steer" })
      expect(cancel).not.toHaveBeenCalled()
    })

    it("granted interrupt → cancels the turn and delivers now", async () => {
      const { parent, parentAgent, msg } = setup()
      await registry.enqueuePrompt(parent.id, "long work", {})
      const r = await registry.sendMessage(msg("interrupt"), { allowInterrupt: true })
      expect(r).toMatchObject({ delivered: { via: "interrupt" }, queued: false, urgencyApplied: "interrupt" })
      await until(() => parentAgent.sent.length === 2)
      expect(parentAgent.sent[1]).toContain("msg interrupt")
    })

    it("next-turn stays next-turn even when the agent could steer", async () => {
      const steer = vi.fn<SteerFn>(async () => "steered")
      const { parent, msg } = setup(steer)
      await registry.enqueuePrompt(parent.id, "long work", {})
      const r = await registry.sendMessage(msg("next-turn"))
      expect(r).toMatchObject({ delivered: null, queued: true, urgencyApplied: "next-turn" })
      expect(steer).not.toHaveBeenCalled()
    })

    it("steer with a non-steering agent → next-turn", async () => {
      const { parent, msg } = setup()
      await registry.enqueuePrompt(parent.id, "long work", {})
      const r = await registry.sendMessage(msg("steer"))
      expect(r).toMatchObject({ queued: true, urgencyApplied: "next-turn" })
      expect(registry.get(parent.id)!.promptQueue).toHaveLength(1)
    })

    it("steer race: the agent says promptRequired (its turn just settled) → falls back to the queue", async () => {
      const steer = vi.fn<SteerFn>(async () => "promptRequired")
      const { parent, msg } = setup(steer)
      await registry.enqueuePrompt(parent.id, "long work", {})
      const m = msg("steer")
      const r = await registry.sendMessage(m)
      expect(steer).toHaveBeenCalledTimes(1)
      expect(r).toMatchObject({ queued: true, urgencyApplied: "next-turn" })
      expect(registry.get(parent.id)!.promptQueue!.map(q => q.envelope?.id)).toEqual([m.id])
      // Not taught yet — the steer never reached the model.
      expect(registry.get(parent.id)?.messagePreambleSent).toBeFalsy()
    })

    it(`rate limit: at most one steer per ${STEER_MIN_INTERVAL_MS}ms per recipient; the excess is next-turn`, async () => {
      const steer = vi.fn<SteerFn>(async () => "steered")
      const { parent, msg } = setup(steer)
      await registry.enqueuePrompt(parent.id, "long work", {})
      expect(await registry.sendMessage(msg("steer", "one"))).toMatchObject({ delivered: { via: "steer" } })
      expect(await registry.sendMessage(msg("steer", "two"))).toMatchObject({ queued: true, urgencyApplied: "next-turn" })
      expect(steer).toHaveBeenCalledTimes(1)
      // The second steer carries no preamble: taught on the first.
    })

    it("#1407 still holds: an interrupted turn doesn't drain queued messages", async () => {
      const { parent, parentAgent, msg } = setup()
      await registry.enqueuePrompt(parent.id, "long work", {})
      const m = msg("next-turn")
      await registry.sendMessage(m)
      await registry.interruptSession(parent.id)
      await until(() => registry.get(parent.id)?.busy === false)
      await new Promise(r => setTimeout(r, 30))
      expect(parentAgent.sent).toEqual(["long work"])
      expect(registry.get(parent.id)!.promptQueue!.map(q => q.envelope?.id)).toEqual([m.id])
    })
  })

  describe("busy recipient (agent-autonomous turn, #1410)", () => {
    it("never steers into an autonomous cycle — queued, and drained when the cycle ends", async () => {
      const steer = vi.fn<SteerFn>(async () => "steered")
      const { parent, parentAgent, msg } = setup(steer)
      parentAgent.emitOutOfTurn({ kind: "text-delta", text: "waking up on my own" })
      await until(() => registry.get(parent.id)?.busy === true)
      const m = msg("steer")
      const r = await registry.sendMessage(m)
      expect(steer).not.toHaveBeenCalled()
      expect(r).toMatchObject({ queued: true, urgencyApplied: "next-turn" })
      parentAgent.emitOutOfTurn({ kind: "usage_update", size: 1000, used: 10, cost: { amount: 0.01, currency: "USD" } } as AgentStreamEvent)
      await until(() => parentAgent.sent.length === 1)
      expect(parentAgent.sent[0]).toContain(m.id)
    })
  })

  describe("recipient parked in inbox_wait", () => {
    it.each(["fyi", "next-turn", "steer", "interrupt"] as const)("%s resolves the wait (waiter first)", async urgency => {
      const steer = vi.fn<SteerFn>(async () => "steered")
      const { parent, msg } = setup(steer)
      await registry.enqueuePrompt(parent.id, "supervise", {})
      const waiting = registry.waitForMessages(parent.id, { from: "children" }, { timeoutMs: 3000 })
      await until(() => registry.get(parent.id)?.blockedOn === "inbox")
      const r = await registry.sendMessage(msg(urgency), { allowInterrupt: true })
      expect(r).toMatchObject({ delivered: { via: "wait" }, queued: false })
      expect((await waiting).messages).toHaveLength(1)
      expect(steer).not.toHaveBeenCalled()
    })
  })
})
