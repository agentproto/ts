/**
 * Mid-turn activity stamping (observed 2026-10-18, host daemon incident).
 *
 * A sandbox proxy session's adapter runs ON the box — the host only sees
 * the proxy's streamed events, so the ACP `onActivity` activity circuit
 * (fired by adapter process traffic for local sessions) never pulses. The
 * descriptor's `lastActivityAt` then stays at `startedAt` for the whole
 * turn, and the idle reaper measured "silence" from box creation: a
 * session 72 tool calls into a busy first turn was reaped 19m20s after
 * its box was created.
 *
 * Fix: `runAgentTurn` pulses `lastActivityAt` from its own event loop.
 * Plus a defensive primitive guard: a busy (mid-turn) row is never
 * reapable, whatever the sweep saw.
 */

import { describe, it, expect } from "vitest"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { runIdleReapPass } from "../idle-reaper.js"

function eventfulAgentSession(events: unknown[]): AgentSessionLike {
  return {
    sessionId: "fake-session",
    async *send() {
      for (const evt of events) {
        // Space events out slightly so timestamps can strictly increase.
        await new Promise(res => setTimeout(res, 5))
        yield evt
      }
    },
    async cancel() {},
    async close() {},
  } as unknown as AgentSessionLike
}

describe("runAgentTurn pulses lastActivityAt from the turn's own event stream", () => {
  it("stamps lastActivityAt on turn output, even when the adapter never pulses onActivity", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: eventfulAgentSession([
        { kind: "tool-call", toolCallId: "t1", toolName: "bash" },
        { kind: "text-delta", text: "working on it" },
        { kind: "turn-end", reason: "completed" },
      ]),
      adapterSlug: "fake",
    })
    expect(reg.get(desc.id)?.lastActivityAt).toBeUndefined()
    await reg.sendPrompt(desc.id, "Do a bunch of real work")
    // The proxy streamed tool-call/text events without any adapter-process
    // traffic — `lastActivityAt` must still have been stamped by the turn
    // loop, and it must be fresh (old stamps, e.g. pre-turn reads, are
    // rejected by the turn finally stamping a terminal state).
    const after = reg.get(desc.id)
    expect(after?.lastActivityAt).toBeDefined()
    const lastMs = Date.parse(after!.lastActivityAt as string)
    expect(Number.isFinite(lastMs)).toBe(true)
    expect(lastMs).toBeGreaterThanOrEqual(Date.parse(after!.startedAt ?? after!.endedAt!))
    reg.shutdown()
  })

  it("a turn that ends by a stream death still leaves the last event's stamp behind", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      // An adapter whose stream dies without a turn-end (the classic stall):
      // the text-delta stamp must survive for the watchdog/reaper to age
      // silence from.
      agentSession: eventfulAgentSession([
        { kind: "tool-call", toolCallId: "t1", toolName: "bash" },
        { kind: "text-delta", text: "halfway through the build" },
      ]),
      adapterSlug: "fake",
    })
    await reg.sendPrompt(desc.id, "Start a long build")
    const after = reg.get(desc.id)
    expect(after?.lastActivityAt).toBeDefined()
    expect(Date.parse(after!.lastActivityAt as string)).toBeGreaterThan(
      Date.parse("1970-01-01T00:00:00Z"),
    )
    reg.shutdown()
  })
})

describe("reapIdle refuses a busy (mid-turn) session", () => {
  it("returns false and leaves the row running while a turn is in flight", async () => {
    const reg = createSessionsRegistry({ persist: false })
    let release: () => void = () => undefined
    const gate = new Promise<void>(res => {
      release = res
    })
    let hangArmed = false
    const hanging = {
      sessionId: "hanging",
      async *send() {
        // The first (this) turn hangs mid-stream until the gate releases;
        // any later invocation must not await it again.
        if (!hangArmed) {
          hangArmed = true
          await gate
        }
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    } as unknown as AgentSessionLike
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: hanging,
      adapterSlug: "fake",
    })
    // Start an explicit turn that will hang mid-stream...
    const turnPromise = reg.sendPrompt(desc.id, "Start a very long build")
    await new Promise(res => setTimeout(res, 20))
    expect(reg.get(desc.id)?.busy).toBe(true)
    // ...try to reap it mid-turn — must be refused...
    expect(reg.reapIdle(desc.id)).toBe(false)
    expect(reg.get(desc.id)?.status).toBe("running")
    // ...and settle only when the (hung) stream is released.
    release()
    await turnPromise
    expect(reg.get(desc.id)?.status).toBe("running")
    reg.shutdown()
  })

  it("the sweep policy still refuses busy rows on its own (regression)", () => {
    const row = (over: Record<string, unknown>): Record<string, unknown> => ({
      kind: "agent-cli",
      status: "running",
      startedAt: "2026-07-23T00:00:00Z",
      lastActivityAt: "2026-07-23T00:00:00Z",
      adapterSlug: "fake",
      cwd: "/tmp",
      ...over,
    })
    const reaped: string[] = []
    const registry = {
      list: () => [row({ id: "busy", busy: true })],
      reapIdle: (id: string) => {
        reaped.push(id)
        return true
      },
    }
    // One hour after lastActivityAt — would be reaped if busy were ignored.
    const summary = runIdleReapPass({
      registry: registry as unknown as Parameters<typeof runIdleReapPass>[0]["registry"],
      idleReapAfterMs: 30 * 60_000,
      now: () => Date.parse("2026-07-23T01:00:00Z"),
    })
    expect(summary.reaped).toBe(0)
    expect(reaped).toEqual([])
  })
})
