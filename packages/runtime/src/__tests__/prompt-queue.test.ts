/**
 * The daemon-side FIFO prompt queue (`enqueuePrompt`'s `queue`/`force`
 * opts, `SessionDescriptor.promptQueue`, `removeQueuedPrompt`) — the
 * server-side replacement for the VS Code webview's old client-only
 * single-slot `queuedText` (which just retried on a 409 and could only
 * ever hold one pending message). See `enqueuePrompt`'s doc comment in
 * sessions.ts for the full contract this exercises:
 *
 *   - `queue: true` on a BUSY session appends instead of rejecting.
 *   - `force: true` (only meaningful alongside `queue`) inserts at the
 *     FRONT of the FIFO — ahead of anything already waiting — without
 *     touching the live turn (that's `interrupt`'s job, not `force`'s).
 *   - `interrupt: true` still wins outright: it cancels + redirects
 *     immediately, `queue`/`force` never get a look-in.
 *   - `queue`/`force` are no-ops on an IDLE session — falls straight
 *     through to the normal immediate-dispatch path.
 *   - The queue drains one item at a time, in order, at the end of
 *     every `runAgentTurn` (`dispatchQueuedPrompt`) — no caller blocks
 *     on it.
 *   - `removeQueuedPrompt` cancels one not-yet-dispatched item by id.
 */

import { describe, it, expect, vi } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"

import { createMcpServer } from "@agentproto/mcp-server"

import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

/** `runAgentTurn` auto-wraps a raw string prompt into a single ACP text
 *  content block before handing it to `agentSession.send()`. */
function wrapped(text: string): string {
  return JSON.stringify({ type: "text", text })
}

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

function noopConversations(): ConversationStore {
  return {
    async open() {},
    async appendTurn() {},
    async read() {
      return { meta: {} as never, turns: [] }
    },
    async list() {
      return []
    },
    pathFor: (id: string) => id,
  }
}

function noopHeartbeat(): HeartbeatRunner {
  return { start() {}, stop() {}, async fireNow() {} }
}

/** A fake agent-cli session whose FIRST turn hangs until `release()` is
 *  called; every subsequent turn completes the instant it starts. Each
 *  `send(message)` call is recorded in `events`, in the order the
 *  adapter actually saw them — the thing FIFO-ordering tests assert on. */
function multiTurnAgentSession(): {
  agent: AgentSessionLike
  release: () => void
  events: string[]
} {
  const events: string[] = []
  let turn = 0
  let releaseFirst!: () => void
  const gate = new Promise<void>(resolve => {
    releaseFirst = resolve
  })
  const agent: AgentSessionLike = {
    sessionId: "multi-turn-session",
    async *send(message: unknown) {
      turn++
      events.push(`turn${turn}-start:${JSON.stringify(message)}`)
      if (turn === 1) await gate
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {
      releaseFirst()
    },
    async close() {},
  }
  return { agent, release: () => releaseFirst(), events }
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

function hangingAgentSession(): { agent: AgentSessionLike; release: () => void } {
  let release!: () => void
  const gate = new Promise<void>(res => {
    release = res
  })
  const agent: AgentSessionLike = {
    sessionId: "hanging-session",
    async *send() {
      await gate
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
  return { agent, release }
}

/** Polls a real (not fake) timer until `fn()` is truthy — the drain
 *  chain runs as a series of fire-and-forget microtask/IIFE hops
 *  (`dispatchQueuedPrompt`), not a single awaitable promise, so tests
 *  observe it settling rather than awaiting one call. */
async function waitUntil(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`)
    }
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

async function mcpServerFactory() {
  return (await createMcpServer({ specs: [], name: "main", version: "0" })).server
}

describe("enqueuePrompt({queue: true}) — FIFO append", () => {
  it("appends to the back of the queue while busy, without dispatching or throwing", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const { agent, events } = multiTurnAgentSession()
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })

    const firstPromise = reg.sendPrompt(desc.id, "first")
    await Promise.resolve()
    expect(reg.get(desc.id)?.busy).toBe(true)

    await reg.enqueuePrompt(desc.id, "second", { queue: true })
    await reg.enqueuePrompt(desc.id, "third", { queue: true })

    // Neither queued call dispatched anything — only turn 1 has started,
    // and the queue holds both, in arrival order.
    expect(events).toEqual([`turn1-start:${wrapped("first")}`])
    expect(reg.get(desc.id)?.promptQueue?.map(p => p.message)).toEqual(["second", "third"])
    expect(reg.get(desc.id)?.busy).toBe(true)

    void firstPromise.catch(() => undefined)
    reg.kill(desc.id)
    reg.shutdown()
  })

  it("drains queued prompts one at a time, in FIFO order, once the live turn ends", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const { agent, release, events } = multiTurnAgentSession()
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })

    const firstPromise = reg.sendPrompt(desc.id, "first")
    await Promise.resolve()

    await reg.enqueuePrompt(desc.id, "second", { queue: true })
    await reg.enqueuePrompt(desc.id, "third", { queue: true })

    release()
    await firstPromise
    await waitUntil(() => events.length === 3)

    expect(events).toEqual([
      `turn1-start:${wrapped("first")}`,
      `turn2-start:${wrapped("second")}`,
      `turn3-start:${wrapped("third")}`,
    ])
    expect(reg.get(desc.id)?.promptQueue).toEqual([])
    expect(reg.get(desc.id)?.busy).toBe(false)
    reg.shutdown()
  })
})

describe("enqueuePrompt({queue: true, force: true}) — jump the FIFO", () => {
  it("inserts at the FRONT of the queue, ahead of prompts already waiting", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const { agent, release, events } = multiTurnAgentSession()
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })

    const firstPromise = reg.sendPrompt(desc.id, "first")
    await Promise.resolve()

    await reg.enqueuePrompt(desc.id, "second", { queue: true })
    await reg.enqueuePrompt(desc.id, "third", { queue: true, force: true })

    // "third" jumped ahead of "second" — front insert, not a swap.
    expect(reg.get(desc.id)?.promptQueue?.map(p => p.message)).toEqual(["third", "second"])

    release()
    await firstPromise
    await waitUntil(() => events.length === 3)

    expect(events).toEqual([
      `turn1-start:${wrapped("first")}`,
      `turn2-start:${wrapped("third")}`,
      `turn3-start:${wrapped("second")}`,
    ])
    reg.shutdown()
  })

  it("does NOT touch the live turn — only reorders what's already waiting", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const { agent, events } = multiTurnAgentSession()
    const cancelSpy = vi.spyOn(agent, "cancel")
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })

    const firstPromise = reg.sendPrompt(desc.id, "first")
    await Promise.resolve()

    await reg.enqueuePrompt(desc.id, "second", { queue: true, force: true })

    expect(cancelSpy).not.toHaveBeenCalled()
    expect(events).toEqual([`turn1-start:${wrapped("first")}`])

    void firstPromise.catch(() => undefined)
    reg.kill(desc.id)
    reg.shutdown()
  })
})

describe("interrupt vs. queue precedence", () => {
  it("interrupt: true wins outright — cancels and redirects immediately, queue: true never takes effect", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const { agent, events } = multiTurnAgentSession()
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })

    const firstPromise = reg.sendPrompt(desc.id, "first")
    await Promise.resolve()

    // `multiTurnAgentSession`'s cancel() releases the hung first turn
    // itself, so this settles without a separate release() call.
    await reg.enqueuePrompt(desc.id, "second", { interrupt: true, queue: true })

    expect(events).toEqual([
      `turn1-start:${wrapped("first")}`,
      `turn2-start:${wrapped("second")}`,
    ])
    // Dispatched directly — never touched the queue.
    expect(reg.get(desc.id)?.promptQueue ?? []).toEqual([])

    await firstPromise
    reg.shutdown()
  })
})

describe("enqueuePrompt({queue: true}) on an idle session", () => {
  it("is a no-op flag — dispatches immediately, exactly like a normal prompt", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
    })

    await reg.enqueuePrompt(desc.id, "hello", { queue: true })
    // `enqueuePrompt` only awaits ADMISSION — the turn itself dispatches
    // fire-and-forget, same as the non-queue path, so its completion
    // (turnsCompleted) lands a tick later.
    await waitUntil(() => reg.get(desc.id)?.turnsCompleted === 1)

    expect(reg.get(desc.id)?.promptQueue ?? []).toEqual([])
    reg.shutdown()
  })
})

describe("queue omitted/false on a busy session — unchanged default behavior", () => {
  it("still throws the mid-turn error and never silently queues", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const { agent, release } = hangingAgentSession()
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })

    const firstPromise = reg.sendPrompt(desc.id, "first")
    await Promise.resolve()

    await expect(reg.enqueuePrompt(desc.id, "second")).rejects.toThrow(/mid-turn/)
    await expect(reg.enqueuePrompt(desc.id, "third", { queue: false })).rejects.toThrow(
      /mid-turn/,
    )
    expect(reg.get(desc.id)?.promptQueue ?? []).toEqual([])

    release()
    await firstPromise
    reg.shutdown()
  })
})

describe("removeQueuedPrompt", () => {
  it("cancels one queued item before it dispatches — the rest still drain, in order", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const { agent, release, events } = multiTurnAgentSession()
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })

    const firstPromise = reg.sendPrompt(desc.id, "first")
    await Promise.resolve()

    await reg.enqueuePrompt(desc.id, "second", { queue: true })
    await reg.enqueuePrompt(desc.id, "third", { queue: true })
    const secondId = reg.get(desc.id)?.promptQueue?.[0]?.id
    expect(secondId).toBeTruthy()

    expect(reg.removeQueuedPrompt(desc.id, secondId!)).toEqual({ removed: true })
    expect(reg.get(desc.id)?.promptQueue?.map(p => p.message)).toEqual(["third"])

    // Idempotent — already gone.
    expect(reg.removeQueuedPrompt(desc.id, secondId!)).toEqual({ removed: false })

    release()
    await firstPromise
    await waitUntil(() => events.length === 2)

    expect(events).toEqual([
      `turn1-start:${wrapped("first")}`,
      `turn2-start:${wrapped("third")}`,
    ])
    reg.shutdown()
  })

  it("is a no-op ({removed: false}) for an unknown session, not a throw", () => {
    const reg = createSessionsRegistry({ persist: false })
    expect(reg.removeQueuedPrompt("sess_nope", "q_nope")).toEqual({ removed: false })
    reg.shutdown()
  })
})

describe("HTTP POST /sessions/:id/prompt?wait=false — queue/force wiring", () => {
  it("busy + queue:true → 202 {queued:true, pending:true, queueId, queuePosition}; force:true jumps to position 1", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { agent, release } = hangingAgentSession()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })

    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession: vi.fn(),
      commandPreview: "mock-adapter",
    })
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: registry,
      resolveAgentAdapter,
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const firstRes = await fetch(
        `http://127.0.0.1:${port}/sessions/${desc.id}/prompt?wait=false`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "first" }),
        },
      )
      expect(firstRes.status).toBe(202)
      expect(registry.get(desc.id)?.busy).toBe(true)

      const secondRes = await fetch(
        `http://127.0.0.1:${port}/sessions/${desc.id}/prompt?wait=false`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "second", queue: true }),
        },
      )
      expect(secondRes.status).toBe(202)
      const secondBody = (await secondRes.json()) as {
        queued: boolean
        pending?: boolean
        queueId?: string
        queuePosition?: number
      }
      expect(secondBody.queued).toBe(true)
      expect(secondBody.pending).toBe(true)
      expect(secondBody.queueId).toBeTruthy()
      expect(secondBody.queuePosition).toBe(1)

      const thirdRes = await fetch(
        `http://127.0.0.1:${port}/sessions/${desc.id}/prompt?wait=false`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "third", queue: true, force: true }),
        },
      )
      const thirdBody = (await thirdRes.json()) as { queuePosition?: number }
      // force jumped it ahead of "second" — front of the queue.
      expect(thirdBody.queuePosition).toBe(1)
      expect(
        registry.get(desc.id)?.promptQueue?.map(p => p.message),
      ).toEqual(["third", "second"])

      // DELETE removes one queued item by the id the POST echoed back.
      const deleteRes = await fetch(
        `http://127.0.0.1:${port}/sessions/${desc.id}/queue/${secondBody.queueId}`,
        { method: "DELETE" },
      )
      expect(deleteRes.status).toBe(200)
      expect(await deleteRes.json()).toEqual({
        ok: true,
        id: desc.id,
        queueId: secondBody.queueId,
        removed: true,
      })
      expect(registry.get(desc.id)?.promptQueue?.map(p => p.message)).toEqual(["third"])

      // Idempotent re-delete.
      const redeleteRes = await fetch(
        `http://127.0.0.1:${port}/sessions/${desc.id}/queue/${secondBody.queueId}`,
        { method: "DELETE" },
      )
      expect((await redeleteRes.json()) as { removed: boolean }).toMatchObject({
        removed: false,
      })

      release()
      await new Promise(res => setTimeout(res, 10))
    } finally {
      await http.stop()
    }
    registry.shutdown()
  })

  it("idle + queue:true dispatches immediately — 202 {queued:true} with no pending/queueId", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
    })

    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession: vi.fn(),
      commandPreview: "mock-adapter",
    })
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: registry,
      resolveAgentAdapter,
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sessions/${desc.id}/prompt?wait=false`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "hello", queue: true }),
      })
      expect(res.status).toBe(202)
      const body = (await res.json()) as Record<string, unknown>
      expect(body).toEqual({ ok: true, id: desc.id, queued: true })
    } finally {
      await http.stop()
    }
    registry.shutdown()
  })
})
