/**
 * Queued follow digests coalesce in place: a busy follower sees ONE waiting
 * digest carrying every event from every flush, not N digests each holding
 * only its own batch. The union is computed synchronously against the item
 * actually still queued, and its payload is plain JSON so it survives a
 * daemon restart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSessionsRegistry,
  type AgentSessionLike,
  type QueuedPrompt,
  type SessionDescriptor,
  type SessionsRegistry,
} from "../sessions.js"
import { createSessionEventBus, type SessionEventBus } from "../session-event-bus.js"
import { createSessionFollowStore, type SessionFollowInput } from "../session-follow-store.js"
import { wireSessionFollow, type SessionFollowHandle } from "../session-follow.js"

const NOW = "2026-10-25T00:00:00.000Z"

function liveAgentSession(sessionId: string): AgentSessionLike {
  return {
    sessionId,
    pid: process.pid,
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

function controllableAgentSession(sessionId: string) {
  const messages: unknown[] = []
  let resolveTurn: (() => void) | null = null
  const session: AgentSessionLike = {
    sessionId,
    pid: process.pid,
    async *send(message) {
      messages.push(message)
      await new Promise<void>(resolve => {
        resolveTurn = resolve
      })
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
  return {
    session,
    messages,
    finishTurn: () => {
      const r = resolveTurn
      resolveTurn = null
      r?.()
    },
  }
}

async function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function queueOf(reg: SessionsRegistry, id: string): QueuedPrompt[] {
  return reg.get(id)?.promptQueue ?? []
}

describe("session-follow digest merge", () => {
  let tmp: string
  let bus: SessionEventBus
  let handle: SessionFollowHandle | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "session-follow-merge-"))
    bus = createSessionEventBus()
  })

  afterEach(() => {
    handle?.dispose()
    handle = undefined
    rmSync(tmp, { recursive: true, force: true })
  })

  function wire(reg: SessionsRegistry, follow: Partial<SessionFollowInput> & { follower: string }) {
    const store = createSessionFollowStore({ persist: false })
    store.upsert({ selector: { all: true }, batchMs: 0, ...follow })
    handle = wireSessionFollow({
      registry: reg,
      sessionEvents: bus,
      store,
      readLastOutput: () => undefined,
      parkedPath: join(tmp, "parked.jsonl"),
      log: () => {},
    })
    return store
  }

  function spawnSource(
    reg: SessionsRegistry,
    id: string,
    label: string,
  ): SessionDescriptor {
    return reg.spawnAgent({
      id,
      workspaceSlug: "default",
      cwd: `/tmp/${id}`,
      label,
      agentSession: liveAgentSession(id),
      adapterSlug: "fake",
    })
  }

  it("two flushes for one busy follower become one queued digest carrying both batches", async () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
    const followerSession = controllableAgentSession("follower")
    const follower = reg.spawnAgent({
      id: "follower",
      workspaceSlug: "default",
      cwd: "/tmp/follower",
      agentSession: followerSession.session,
      adapterSlug: "fake",
    })
    const alpha = spawnSource(reg, "alpha", "alpha-source")
    const beta = spawnSource(reg, "beta", "beta-source")
    wire(reg, { follower: follower.id })

    await reg.enqueuePrompt(follower.id, "start", {})
    expect(reg.get(follower.id)?.busy).toBe(true)

    bus.emit({ type: "session:exited", sessionId: alpha.id, status: "exited", ts: NOW })
    await handle!.flush()
    const first = queueOf(reg, follower.id)[0]!
    expect(first.digest?.entries).toHaveLength(1)
    const firstEnvelopeId = first.envelope!.id

    bus.emit({ type: "session:exited", sessionId: beta.id, status: "exited", ts: NOW })
    await handle!.flush()

    const queue = queueOf(reg, follower.id)
    expect(queue).toHaveLength(1)
    expect(queue[0]!.id).toBe(first.id)
    expect(queue[0]!.coalescedCount).toBe(2)
    expect(queue[0]!.digest?.entries.map(e => e.sessionId)).toEqual([alpha.id, beta.id])
    expect(queue[0]!.message).toContain("alpha-source (alpha)")
    expect(queue[0]!.message).toContain("beta-source (beta)")
    expect(queue[0]!.envelope!.text).toContain("alpha-source (alpha)")
    expect(queue[0]!.envelope!.text).toContain("beta-source (beta)")
    expect(queue[0]!.message).toContain("Coalesced from 2 queued digests")

    // Exactly one digest in the inbox, and it is the REPLACING envelope.
    const digests = (reg.get(follower.id)?.inbox ?? []).filter(m => m.text.includes("[session-follow]"))
    expect(digests).toHaveLength(1)
    expect(digests[0]!.id).toBe(queue[0]!.envelope!.id)
    expect(digests[0]!.id).not.toBe(firstEnvelopeId)
    expect(digests[0]!.text).toContain("alpha-source (alpha)")
    expect(digests[0]!.text).toContain("beta-source (beta)")

    followerSession.finishTurn()
    reg.shutdown()
  })

  it("survives a restart: the restored digest is merged with the next one", async () => {
    const persistPath = join(tmp, "sessions.json")
    const reg1 = createSessionsRegistry({ persistPath, transcriptDir: tmp, sessionEvents: bus })
    const followerSession1 = controllableAgentSession("follower-1")
    const follower = reg1.spawnAgent({
      id: "persist-follower",
      workspaceSlug: "default",
      cwd: "/tmp/persist-follower",
      agentSession: followerSession1.session,
      adapterSlug: "fake",
    })
    const alpha = spawnSource(reg1, "alpha", "alpha-source")
    wire(reg1, { follower: follower.id })

    await reg1.enqueuePrompt(follower.id, "start", {})
    bus.emit({ type: "session:exited", sessionId: alpha.id, status: "exited", ts: NOW })
    await handle!.flush()

    const first = queueOf(reg1, follower.id)[0]!
    expect(first.digest?.entries.map(e => e.sessionId)).toEqual([alpha.id])
    handle!.dispose()
    handle = undefined
    reg1.shutdown()

    const persisted = JSON.parse(readFileSync(persistPath, "utf8")) as { sessions: SessionDescriptor[] }
    const row = persisted.sessions.find(s => s.id === follower.id)!
    expect(row.promptQueue?.[0]?.digest?.entries.map(e => e.sessionId)).toEqual([alpha.id])

    const bus2 = createSessionEventBus()
    const reg2 = createSessionsRegistry({ persistPath, transcriptDir: tmp, sessionEvents: bus2 })
    const restoredQueue = queueOf(reg2, follower.id)
    expect(restoredQueue[0]?.digest?.entries.map(e => e.sessionId)).toEqual([alpha.id])
    const restoredId = restoredQueue[0]!.id

    // Bring the persisted follower back under the same id with a live agent,
    // then drop its restored queue onto the live row.
    expect(reg2.forgetSession(follower.id)).toBe("forgotten")
    const followerSession2 = controllableAgentSession("follower-2")
    const revived = reg2.spawnAgent({
      id: follower.id,
      workspaceSlug: "default",
      cwd: "/tmp/persist-follower",
      agentSession: followerSession2.session,
      adapterSlug: "fake",
    })
    reg2.get(revived.id)!.promptQueue = restoredQueue

    const beta = spawnSource(reg2, "beta", "beta-source")
    const store = createSessionFollowStore({ persist: false })
    store.upsert({ follower: follower.id, selector: { all: true }, batchMs: 0 })
    handle = wireSessionFollow({
      registry: reg2,
      sessionEvents: bus2,
      store,
      readLastOutput: () => undefined,
      parkedPath: join(tmp, "parked.jsonl"),
      log: () => {},
    })

    await reg2.enqueuePrompt(follower.id, "start", {})
    bus2.emit({ type: "session:exited", sessionId: beta.id, status: "exited", ts: NOW })
    await handle!.flush()

    const queue = queueOf(reg2, follower.id)
    expect(queue).toHaveLength(1)
    expect(queue[0]!.id).toBe(restoredId)
    expect(queue[0]!.coalescedCount).toBe(2)
    expect(queue[0]!.digest?.entries.map(e => e.sessionId)).toEqual([alpha.id, beta.id])
    expect(queue[0]!.message).toContain("alpha-source (alpha)")
    expect(queue[0]!.message).toContain("beta-source (beta)")

    followerSession2.finishTurn()
    reg2.shutdown()
  })

  it("a drain race leaves the new digest fresh, with no duplicate of the delivered one", async () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
    const followerSession = controllableAgentSession("follower")
    const follower = reg.spawnAgent({
      id: "follower",
      workspaceSlug: "default",
      cwd: "/tmp/follower",
      agentSession: followerSession.session,
      adapterSlug: "fake",
    })
    const alpha = spawnSource(reg, "alpha", "alpha-source")
    const beta = spawnSource(reg, "beta", "beta-source")
    wire(reg, { follower: follower.id })

    await reg.enqueuePrompt(follower.id, "start", {})
    bus.emit({ type: "session:exited", sessionId: alpha.id, status: "exited", ts: NOW })
    await handle!.flush()
    expect(queueOf(reg, follower.id)).toHaveLength(1)

    // Let the first turn end: digest 1 drains into its own turn.
    followerSession.finishTurn()
    await waitUntil(() => followerSession.messages.length >= 2 && queueOf(reg, follower.id).length === 0)
    expect(reg.get(follower.id)?.busy).toBe(true)
    expect(queueOf(reg, follower.id)).toHaveLength(0)

    bus.emit({ type: "session:exited", sessionId: beta.id, status: "exited", ts: NOW })
    await handle!.flush()

    const queue = queueOf(reg, follower.id)
    expect(queue).toHaveLength(1)
    expect(queue[0]!.coalescedCount).toBeUndefined()
    expect(queue[0]!.digest?.entries.map(e => e.sessionId)).toEqual([beta.id])
    expect(queue[0]!.message).toContain("beta-source (beta)")
    expect(queue[0]!.message).not.toContain("alpha-source (alpha)")

    followerSession.finishTurn()
    reg.shutdown()
  })

  it("caps a merged digest at 50 entries and reports the omitted count", async () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
    const followerSession = controllableAgentSession("follower")
    const follower = reg.spawnAgent({
      id: "follower",
      workspaceSlug: "default",
      cwd: "/tmp/follower",
      agentSession: followerSession.session,
      adapterSlug: "fake",
    })
    const sources: SessionDescriptor[] = []
    for (let i = 0; i < 60; i++) sources.push(spawnSource(reg, `s${i}`, `source-${i}`))
    wire(reg, { follower: follower.id })
    await reg.enqueuePrompt(follower.id, "start", {})

    for (let i = 0; i < 30; i++) {
      bus.emit({ type: "session:exited", sessionId: sources[i]!.id, status: "exited", ts: NOW })
    }
    await handle!.flush()
    for (let i = 30; i < 60; i++) {
      bus.emit({ type: "session:exited", sessionId: sources[i]!.id, status: "exited", ts: NOW })
    }
    await handle!.flush()

    const queue = queueOf(reg, follower.id)
    expect(queue).toHaveLength(1)
    expect(queue[0]!.coalescedCount).toBe(2)
    expect(queue[0]!.digest?.entries).toHaveLength(50)
    expect(queue[0]!.digest?.omitted).toBe(10)
    expect(queue[0]!.digest?.entries[0]?.sessionId).toBe("s10")
    expect(queue[0]!.digest?.entries.at(-1)?.sessionId).toBe("s59")
    expect(queue[0]!.message).toContain("10 earlier events omitted")

    followerSession.finishTurn()
    reg.shutdown()
  })

  it("never merges non-follow queued items, even with identical text", async () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
    const followerSession = controllableAgentSession("follower")
    const follower = reg.spawnAgent({
      id: "follower",
      workspaceSlug: "default",
      cwd: "/tmp/follower",
      agentSession: followerSession.session,
      adapterSlug: "fake",
    })
    const alpha = spawnSource(reg, "alpha", "alpha-source")
    wire(reg, { follower: follower.id })
    await reg.enqueuePrompt(follower.id, "start", {})
    bus.emit({ type: "session:exited", sessionId: alpha.id, status: "exited", ts: NOW })
    await handle!.flush()

    const useMerge = vi.fn(() => {
      throw new Error("merge must not run for non-follow items")
    })
    const first = await reg.enqueuePrompt(follower.id, "same text", { queue: true, merge: useMerge })
    const second = await reg.enqueuePrompt(follower.id, "same text", { queue: true, merge: useMerge })

    expect(useMerge).not.toHaveBeenCalled()
    expect(first.queueId).not.toBe(second.queueId)
    const queue = queueOf(reg, follower.id)
    const plain = queue.filter(p => p.message === "same text")
    expect(plain).toHaveLength(2)
    expect(plain.every(p => p.digest === undefined)).toBe(true)
    expect(queue.filter(p => p.digest !== undefined)).toHaveLength(1)

    followerSession.finishTurn()
    reg.shutdown()
  })
})
