/**
 * "Queued means queued": a prompt parked in `SessionDescriptor.promptQueue`
 * (agent_prompt's default `queue: true` on a mid-turn session) is delivered
 * only after a NATURAL turn-end — never as a side effect of somebody else
 * interrupting the turn it was waiting behind.
 *
 * Incident (sess_17555e45): a supervisor's long blocking Bash call was cut
 * by an interrupt, the adapter settled the turn `cancelled`, and the
 * `dispatchQueuedPrompt` drain in that cancelled turn's `finally` shipped an
 * unrelated queued `agent_prompt` 7ms later — so the queued prompt looked
 * like it had cancelled the turn. It also meant:
 *
 *   - a bare Stop (`interruptSession`, `agent_interrupt`, POST /interrupt)
 *     didn't stop: the next queued prompt started immediately;
 *   - `enqueuePrompt({interrupt: true})` raced that drain for the freed
 *     slot — the queued item usually won, and the redirect prompt the
 *     caller actually sent was rejected as "mid-turn".
 *
 * Contract pinned here: an interrupted turn drains nothing except the item
 * `deliverQueuedPrompt` explicitly asked for; everything else stays queued
 * and drains, in order, after the next turn that ends on its own.
 */

import { describe, it, expect, vi } from "vitest"

import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"

function wrapped(text: string): string {
  return JSON.stringify({ type: "text", text })
}

/** First turn hangs until cancel()/release(); every later turn completes
 *  the instant it starts. Records each send in adapter order. */
function multiTurnAgentSession(): {
  agent: AgentSessionLike
  release: () => void
  events: string[]
} {
  const events: string[] = []
  let turn = 0
  let cancelled = false
  let releaseFirst!: () => void
  const gate = new Promise<void>(resolve => {
    releaseFirst = resolve
  })
  const agent: AgentSessionLike = {
    sessionId: "multi-turn-session",
    async *send(message: unknown) {
      turn++
      events.push(`turn${turn}-start:${JSON.stringify(message)}`)
      if (turn === 1) {
        await gate
        yield { kind: "turn-end", reason: cancelled ? "cancelled" : "completed" }
        return
      }
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {
      cancelled = true
      releaseFirst()
    },
    async close() {},
  }
  return { agent, release: () => releaseFirst(), events }
}

async function waitUntil(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`)
    }
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

/** A few macrotask hops — long enough for any fire-and-forget drain to
 *  have dispatched if it was going to. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 1))
}

function spawn() {
  const reg = createSessionsRegistry({ persist: false })
  const fake = multiTurnAgentSession()
  const desc = reg.spawnAgent({
    workspaceSlug: "default",
    cwd: "/tmp",
    agentSession: fake.agent,
    adapterSlug: "fake",
  })
  return { reg, id: desc.id, ...fake }
}

describe("queued prompts survive an interrupt of the turn they wait behind", () => {
  it("a bare interrupt (Stop) does not dispatch queued prompts — they stay queued", async () => {
    const { reg, id, events } = spawn()
    const first = reg.sendPrompt(id, "long blocking tool call")
    await Promise.resolve()
    await reg.enqueuePrompt(id, "queued note", { queue: true })

    await expect(reg.interruptSession(id)).resolves.toEqual({ wasBusy: true })
    await first
    await settle()

    expect(events).toEqual([`turn1-start:${wrapped("long blocking tool call")}`])
    expect(reg.get(id)?.busy).toBe(false)
    expect(reg.get(id)?.promptQueue?.map(p => p.message)).toEqual(["queued note"])

    // The cancel is attributed in the session's own output, so a
    // `cancelled` turn-end can be traced back to whoever asked for it.
    const lines: string[] = []
    reg.attach(id, line => lines.push(line))?.()
    expect(lines).toContainEqual(
      expect.stringMatching(/turn interrupted by a stop request .*1 queued prompt\(s\) held/)
    )
    reg.shutdown()
  })

  it("after a Stop, the parked queue drains in order once the next turn ends naturally", async () => {
    const { reg, id, events } = spawn()
    const first = reg.sendPrompt(id, "first")
    await Promise.resolve()
    await reg.enqueuePrompt(id, "q1", { queue: true })
    await reg.enqueuePrompt(id, "q2", { queue: true })

    await reg.interruptSession(id)
    await first
    await reg.sendPrompt(id, "after stop")
    await waitUntil(() => events.length === 4)

    expect(events).toEqual([
      `turn1-start:${wrapped("first")}`,
      `turn2-start:${wrapped("after stop")}`,
      `turn3-start:${wrapped("q1")}`,
      `turn4-start:${wrapped("q2")}`,
    ])
    expect(reg.get(id)?.promptQueue).toEqual([])
    reg.shutdown()
  })

  it("interrupt: true delivers the redirect prompt itself, not whatever was queued", async () => {
    const { reg, id, events } = spawn()
    const first = reg.sendPrompt(id, "first")
    await Promise.resolve()
    await reg.enqueuePrompt(id, "queued note", { queue: true })

    await expect(
      reg.enqueuePrompt(id, "redirect now", { interrupt: true })
    ).resolves.toEqual({ queued: false })
    await first
    await waitUntil(() => events.length === 3)

    // The redirect runs first; the queued note waits for the redirect turn
    // to end on its own, then drains.
    expect(events).toEqual([
      `turn1-start:${wrapped("first")}`,
      `turn2-start:${wrapped("redirect now")}`,
      `turn3-start:${wrapped("queued note")}`,
    ])
    reg.shutdown()
  })

  it("deliverQueuedPrompt still dispatches exactly its target; the rest wait for a natural turn-end", async () => {
    const { reg, id, events, agent } = spawn()
    const cancelSpy = vi.spyOn(agent, "cancel")
    const first = reg.sendPrompt(id, "first")
    await Promise.resolve()
    await reg.enqueuePrompt(id, "second", { queue: true })
    await reg.enqueuePrompt(id, "third", { queue: true })

    const third = reg.get(id)!.promptQueue![1]!
    await expect(reg.deliverQueuedPrompt(id, third.id)).resolves.toEqual({
      delivered: true,
      interrupted: true,
    })
    await first
    await waitUntil(() => events.length === 3)

    expect(cancelSpy).toHaveBeenCalledTimes(1)
    expect(events).toEqual([
      `turn1-start:${wrapped("first")}`,
      `turn2-start:${wrapped("third")}`,
      `turn3-start:${wrapped("second")}`,
    ])
    reg.shutdown()
  })

  it("a normal turn-end still drains the queue (no regression)", async () => {
    const { reg, id, events, release } = spawn()
    const first = reg.sendPrompt(id, "first")
    await Promise.resolve()
    await reg.enqueuePrompt(id, "queued note", { queue: true })

    release()
    await first
    await waitUntil(() => events.length === 2)
    expect(events[1]).toBe(`turn2-start:${wrapped("queued note")}`)
    reg.shutdown()
  })
})
