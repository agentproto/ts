/**
 * `agent_prompt`'s `interrupt` flag — a soft Ctrl-C. Today a mid-turn
 * session rejects a new prompt outright; `interrupt: true` instead
 * cancels the in-flight turn (`agentSession.cancel()`), AWAITS it
 * actually settling to idle (busy flips false — driven by the "busy"
 * event `runAgentTurn`'s finally block emits, never a fixed sleep),
 * then admits + delivers the new prompt on the SAME live session.
 *
 * The mock session below models a real adapter's `cancel()` as taking
 * a couple of microtask ticks before the turn actually ends (mirrors
 * ACP `session/cancel`'s async round-trip) — this is what proves the
 * registry genuinely awaits the settle instead of assuming `cancel()`
 * resolving means the turn is already over.
 */

import { describe, it, expect, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerAgentTools } from "../agent-tools.js"
import {
  createSessionsRegistry,
  INTERRUPT_SETTLE_TIMEOUT_MS,
  type AgentSessionLike,
} from "../sessions.js"

/** `runAgentTurn` auto-wraps a raw string prompt into a single ACP
 *  text content block before handing it to `agentSession.send()` — the
 *  fixtures below record that wrapped shape, not the raw string. */
function wrapped(text: string): string {
  return JSON.stringify({ type: "text", text })
}

/** A fake agent-cli session whose first turn hangs until `cancel()`
 *  resolves (two microtask ticks later — no real timers), then yields
 *  a `cancelled` turn-end; any subsequent turn completes immediately.
 *  `events` records the order operations actually happened in. */
function interruptibleAgentSession(): {
  agent: AgentSessionLike
  events: string[]
} {
  const events: string[] = []
  let releaseFirstTurn!: () => void
  const firstTurnGate = new Promise<void>(resolve => {
    releaseFirstTurn = resolve
  })
  let turnCount = 0
  const agent: AgentSessionLike = {
    sessionId: "interruptible-session",
    async *send(message: unknown) {
      turnCount++
      if (turnCount === 1) {
        events.push(`turn1-started:${JSON.stringify(message)}`)
        await firstTurnGate
        events.push("turn1-yielding-cancelled")
        yield { kind: "turn-end", reason: "cancelled" }
        return
      }
      events.push(`turn${turnCount}-started:${JSON.stringify(message)}`)
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {
      events.push("cancel-called")
      // Model the ACP `session/cancel` round-trip: cancel() itself
      // resolves a couple of ticks after being called, and the turn
      // doesn't end until then either — proves the caller waits for
      // the real settle, not just for `cancel()` to return.
      await Promise.resolve()
      await Promise.resolve()
      events.push("cancel-resolved")
      releaseFirstTurn()
    },
    async close() {},
  }
  return { agent, events }
}

/** A fake session that models a genuinely wedged mid-tool-call turn:
 *  `cancel()` returns immediately (mirrors ACP `session/cancel` being a
 *  fire-and-forget notification), but the turn itself only actually
 *  ends `settleDelayMs` later (mirrors the adapter needing its own
 *  force-cancel grace period + a stdio round-trip before it yields). */
function wedgedThenSettlesAgentSession(settleDelayMs: number): AgentSessionLike {
  let releaseFirstTurn!: () => void
  const gate = new Promise<void>(resolve => {
    releaseFirstTurn = resolve
  })
  return {
    sessionId: "wedged-then-settles-session",
    async *send() {
      await gate
      yield { kind: "turn-end", reason: "cancelled" }
    },
    async cancel() {
      setTimeout(releaseFirstTurn, settleDelayMs)
    },
    async close() {},
  }
}

/** A fake session that never settles — `cancel()` resolves but the
 *  turn itself never ends. Used to prove the bounded-timeout arm. */
function neverSettlingAgentSession(): AgentSessionLike {
  return {
    sessionId: "never-settling-session",
    async *send() {
      await new Promise<void>(() => {
        // never resolves
      })
      // unreachable — required so this stays an async generator
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

/** A fake session whose `cancel()` always rejects — models an adapter
 *  that cannot honor an interrupt. */
function uncancelableAgentSession(): AgentSessionLike {
  return {
    sessionId: "uncancelable-session",
    async *send() {
      await new Promise<void>(() => {
        // hangs forever — this session is never actually cancelled
      })
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {
      throw new Error("adapter does not implement session/cancel")
    },
    async close() {},
  }
}

function instantAgentSession(): AgentSessionLike {
  return {
    sessionId: "instant-session",
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

describe("enqueuePrompt({interrupt: true}) — registry", () => {
  it("cancels the in-flight turn, awaits it settling, then delivers the new prompt on the same live session", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const { agent, events } = interruptibleAgentSession()
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })

    const firstPromise = reg.sendPrompt(desc.id, "first")
    await Promise.resolve()
    expect(reg.get(desc.id)?.busy).toBe(true)

    await reg.enqueuePrompt(desc.id, "second", { interrupt: true })

    // Every step happened, and strictly in this order — the new
    // prompt's admission never interleaved with the still-in-flight
    // first turn; it only ran once the cancel genuinely settled.
    expect(events).toEqual([
      `turn1-started:${wrapped("first")}`,
      "cancel-called",
      "cancel-resolved",
      "turn1-yielding-cancelled",
      `turn2-started:${wrapped("second")}`,
    ])

    // Redirected, not killed — the session is still alive.
    expect(reg.get(desc.id)?.status).toBe("running")

    await expect(firstPromise).resolves.toBeUndefined()
    reg.shutdown()
  })

  it("is a no-op on an idle session — behaves exactly like a normal prompt, no spurious cancel", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const agent = instantAgentSession()
    const cancelSpy = vi.spyOn(agent, "cancel")
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })

    await reg.enqueuePrompt(desc.id, "hello", { interrupt: true })

    expect(cancelSpy).not.toHaveBeenCalled()
    reg.shutdown()
  })

  it("interrupt: false on a mid-turn session still throws the mid-turn error, byte-identical to today", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const { agent } = interruptibleAgentSession()
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })

    const firstPromise = reg.sendPrompt(desc.id, "first")
    await Promise.resolve()
    expect(reg.get(desc.id)?.busy).toBe(true)

    await expect(
      reg.enqueuePrompt(desc.id, "second", { interrupt: false })
    ).rejects.toThrow(/mid-turn/)

    // First turn was never cancelled or released — it stays hung
    // forever, so don't await it; just make sure it's not left as an
    // unhandled rejection.
    void firstPromise.catch(() => undefined)
    reg.shutdown()
  })

  it("interrupt omitted on a mid-turn session still throws the mid-turn error (default false)", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const { agent } = interruptibleAgentSession()
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })

    const firstPromise = reg.sendPrompt(desc.id, "first")
    await Promise.resolve()

    await expect(reg.enqueuePrompt(desc.id, "second")).rejects.toThrow(/mid-turn/)

    void firstPromise.catch(() => undefined)
    reg.shutdown()
  })

  it("an adapter that cannot cancel surfaces a clear error instead of hanging or silently rejecting as mid-turn", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const agent = uncancelableAgentSession()
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })

    const firstPromise = reg.sendPrompt(desc.id, "first")
    await Promise.resolve()
    expect(reg.get(desc.id)?.busy).toBe(true)

    await expect(
      reg.enqueuePrompt(desc.id, "second", { interrupt: true })
    ).rejects.toThrow(/does not support interrupt/)

    // The first turn is untouched — still mid-turn, session still alive.
    expect(reg.get(desc.id)?.busy).toBe(true)
    expect(reg.get(desc.id)?.status).toBe("running")

    reg.kill(desc.id)
    void firstPromise.catch(() => undefined)
    reg.shutdown()
  })

  it("rejects with a clear timeout error when a cancelled turn never actually settles", async () => {
    vi.useFakeTimers()
    try {
      const reg = createSessionsRegistry({ persist: false })
      const agent = neverSettlingAgentSession()
      const desc = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: agent,
        adapterSlug: "fake",
      })

      void reg.sendPrompt(desc.id, "first")
      await vi.advanceTimersByTimeAsync(0)
      expect(reg.get(desc.id)?.busy).toBe(true)

      const interruptPromise = reg.enqueuePrompt(desc.id, "second", {
        interrupt: true,
      })
      const assertion = expect(interruptPromise).rejects.toThrow(
        /did not settle after interrupt/
      )
      await vi.advanceTimersByTimeAsync(INTERRUPT_SETTLE_TIMEOUT_MS)
      await assertion

      reg.kill(desc.id)
      reg.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not spuriously time out when a genuinely wedged mid-tool-call turn takes tens of seconds to settle", async () => {
    vi.useFakeTimers()
    try {
      const reg = createSessionsRegistry({ persist: false })
      // Longer than the OLD 30s bound this regression-tests against,
      // but comfortably inside INTERRUPT_SETTLE_TIMEOUT_MS.
      const settleDelayMs = 45_000
      const agent = wedgedThenSettlesAgentSession(settleDelayMs)
      const desc = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: agent,
        adapterSlug: "fake",
      })

      void reg.sendPrompt(desc.id, "first")
      await vi.advanceTimersByTimeAsync(0)
      expect(reg.get(desc.id)?.busy).toBe(true)

      const interruptPromise = reg.enqueuePrompt(desc.id, "second", {
        interrupt: true,
      })
      await vi.advanceTimersByTimeAsync(settleDelayMs)
      await expect(interruptPromise).resolves.toBeUndefined()

      reg.kill(desc.id)
      reg.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("sendPrompt({interrupt: true}) — the BLOCKING arm", () => {
  // Regression: `interrupt` was parsed by POST /sessions/:id/prompt and then
  // silently DROPPED unless ?wait=false, because sendPrompt took no opts at
  // all. A caller asking to redirect a mid-turn session got the busy 409 it
  // had explicitly asked not to get. Both arms must now behave identically.

  it("cancels the in-flight turn, awaits it settling, then delivers the new prompt on the same session", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const { agent, events } = interruptibleAgentSession()
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })

    const firstPromise = reg.sendPrompt(desc.id, "first")
    await Promise.resolve()
    expect(reg.get(desc.id)?.busy).toBe(true)

    // Same assertion as the enqueuePrompt case — and unlike enqueuePrompt,
    // this one only resolves once the SECOND turn has actually run.
    await reg.sendPrompt(desc.id, "second", { interrupt: true })

    expect(events).toEqual([
      `turn1-started:${wrapped("first")}`,
      "cancel-called",
      "cancel-resolved",
      "turn1-yielding-cancelled",
      `turn2-started:${wrapped("second")}`,
    ])
    expect(reg.get(desc.id)?.status).toBe("running")

    await expect(firstPromise).resolves.toBeUndefined()
    reg.shutdown()
  })

  it("is a no-op on an idle session — no spurious cancel", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const agent = instantAgentSession()
    const cancelSpy = vi.spyOn(agent, "cancel")
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })

    await reg.sendPrompt(desc.id, "hello", { interrupt: true })

    expect(cancelSpy).not.toHaveBeenCalled()
    reg.shutdown()
  })

  it("interrupt omitted on a mid-turn session still throws the mid-turn error (default false)", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const { agent } = interruptibleAgentSession()
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })

    const firstPromise = reg.sendPrompt(desc.id, "first")
    await Promise.resolve()

    await expect(reg.sendPrompt(desc.id, "second")).rejects.toThrow(/mid-turn/)

    void firstPromise.catch(() => undefined)
    reg.shutdown()
  })

  it("names sendPrompt (not enqueuePrompt) when an adapter cannot cancel", async () => {
    // The interrupt helper is shared by both arms; a message naming the wrong
    // entry point would misdirect whoever is debugging it.
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: uncancelableAgentSession(),
      adapterSlug: "fake",
    })

    void reg.sendPrompt(desc.id, "first")
    await Promise.resolve()

    await expect(reg.sendPrompt(desc.id, "second", { interrupt: true })).rejects.toThrow(
      /^sendPrompt: session .* does not support interrupt/,
    )
    reg.shutdown()
  })
})

describe("agent_prompt (MCP): interrupt", () => {
  it("redirects a mid-turn session to the new prompt instead of rejecting it", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { agent, events } = interruptibleAgentSession()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })

    const server = new McpServer({ name: "prompt-interrupt-server", version: "0.0.0" })
    registerAgentTools(server, { registry })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "prompt-interrupt-client", version: "0.0.0" })
    await client.connect(clientTransport)

    const first = (await client.callTool({
      name: "agent_prompt",
      arguments: { sessionId: desc.id, prompt: "first" },
    })) as { isError?: boolean }
    expect(first.isError).toBeUndefined()
    expect(registry.get(desc.id)?.busy).toBe(true)

    const second = (await client.callTool({
      name: "agent_prompt",
      arguments: { sessionId: desc.id, prompt: "second", interrupt: true },
    })) as { isError?: boolean }
    expect(second.isError).toBeUndefined()

    expect(events).toEqual([
      `turn1-started:${wrapped("first")}`,
      "cancel-called",
      "cancel-resolved",
      "turn1-yielding-cancelled",
      `turn2-started:${wrapped("second")}`,
    ])
    expect(registry.get(desc.id)?.status).toBe("running")
    registry.shutdown()
  })
})
