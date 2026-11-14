/**
 * A persisted, bounded `dedupeKey` on `enqueuePrompt`: a retried prompt
 * (an MCP client that timed out, or a replayed durable reaction) is
 * delivered at most once per key inside the window, even after the first
 * delivery has fully drained from the queue.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSessionsRegistry,
  PROMPT_DEDUPE_MAX,
  PROMPT_DEDUPE_TTL_MS,
  type AgentSessionLike,
  type SessionDescriptor,
  type SessionsRegistry,
} from "../sessions.js"

function countingAgent(sessionId = "dedupe-session"): {
  agent: AgentSessionLike
  prompts: unknown[]
} {
  const prompts: unknown[] = []
  const agent: AgentSessionLike = {
    sessionId,
    async *send(message) {
      prompts.push(message)
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
  return { agent, prompts }
}

function hangingAgent(sessionId = "dedupe-session"): {
  agent: AgentSessionLike
  prompts: unknown[]
  release: () => void
} {
  const prompts: unknown[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const agent: AgentSessionLike = {
    sessionId,
    async *send(message) {
      prompts.push(message)
      await gate
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
  return { agent, prompts, release }
}

function spawn(
  registry: SessionsRegistry,
  agent: AgentSessionLike,
  id = "dedupe-session",
): SessionDescriptor {
  return registry.spawnAgent({
    id,
    workspaceSlug: "default",
    cwd: "/tmp",
    agentSession: agent,
    adapterSlug: "fake",
  })
}

const tmpDirs: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("enqueuePrompt dedupeKey", () => {
  it("idle: the same key twice dispatches exactly one turn and returns duplicate", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { agent, prompts } = countingAgent()
    const desc = spawn(registry, agent)

    const first = await registry.enqueuePrompt(desc.id, "one", { dedupeKey: "idle-key" })
    const second = await registry.enqueuePrompt(desc.id, "two", { dedupeKey: "idle-key" })

    expect(first.delivery).toBe("delivered")
    expect(second).toMatchObject({
      queued: false,
      delivery: "duplicate",
      duplicate: true,
      pending: false,
    })
    await vi.waitFor(() => expect(prompts.length).toBe(1))
    expect(prompts.length).toBe(1)
    registry.shutdown()
  })

  it("idle: two concurrent calls with the same key deliver once and the second answers duplicate", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { agent, prompts } = countingAgent()
    const desc = spawn(registry, agent)

    const results = await Promise.all([
      registry.enqueuePrompt(desc.id, "one", { dedupeKey: "race-key" }),
      registry.enqueuePrompt(desc.id, "two", { dedupeKey: "race-key" }),
    ])

    expect(results.map(result => result.delivery).sort()).toEqual(["delivered", "duplicate"])
    await vi.waitFor(() => expect(prompts.length).toBe(1))
    expect(prompts.length).toBe(1)
    registry.shutdown()
  })

  it("busy: the same key twice leaves one queue item, exposes its key, and returns its queueId", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { agent, release } = hangingAgent()
    const desc = spawn(registry, agent)

    await registry.enqueuePrompt(desc.id, "start", {})
    const first = await registry.enqueuePrompt(desc.id, "waiting", {
      queue: true,
      dedupeKey: "busy-key",
    })
    const second = await registry.enqueuePrompt(desc.id, "retry", {
      queue: true,
      dedupeKey: "busy-key",
    })

    expect(first.delivery).toBe("queued-mid-turn")
    expect(second).toMatchObject({
      queued: false,
      delivery: "duplicate",
      duplicate: true,
      pending: false,
      queueId: first.queueId,
    })
    expect(registry.get(desc.id)?.promptQueue).toHaveLength(1)
    const view = registry.listQueuedPrompts(desc.id)
    expect(view?.[0]?.dedupeKey).toBe("busy-key")

    release()
    registry.shutdown()
  })

  it("still returns duplicate after the queued item drained and its turn finished", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { agent, prompts, release } = hangingAgent()
    const desc = spawn(registry, agent)

    await registry.enqueuePrompt(desc.id, "start", {})
    const queued = await registry.enqueuePrompt(desc.id, "queued", {
      queue: true,
      dedupeKey: "drain-key",
    })
    expect(queued.delivery).toBe("queued-mid-turn")

    release()
    await vi.waitFor(() => {
      expect(prompts.length).toBe(2)
      expect(registry.get(desc.id)?.busy).toBe(false)
      expect(registry.get(desc.id)?.promptQueue).toHaveLength(0)
    })

    const third = await registry.enqueuePrompt(desc.id, "again", { dedupeKey: "drain-key" })
    expect(third).toMatchObject({
      queued: false,
      delivery: "duplicate",
      duplicate: true,
      pending: false,
    })
    await vi.waitFor(() => expect(prompts.length).toBe(2))
    expect(prompts.length).toBe(2)
    registry.shutdown()
  })

  it("different keys, and no key at all, deliver every prompt", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { agent, prompts } = countingAgent()
    const desc = spawn(registry, agent)

    for (const [message, opts] of [
      ["one", { dedupeKey: "key-a" }],
      ["two", { dedupeKey: "key-b" }],
      ["three", {}],
      ["four", {}],
    ] as const) {
      await registry.enqueuePrompt(desc.id, message, opts)
      await vi.waitFor(() => expect(registry.get(desc.id)?.busy).toBe(false))
    }
    await vi.waitFor(() => expect(prompts.length).toBe(4))
    expect(prompts.length).toBe(4)
    registry.shutdown()
  })

  it("an admission throw records nothing, and a retry with the same key is delivered", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { agent, prompts, release } = hangingAgent()
    const desc = spawn(registry, agent)

    await registry.enqueuePrompt(desc.id, "start", {})
    await expect(
      registry.enqueuePrompt(desc.id, "blocked", { dedupeKey: "retry-key" }),
    ).rejects.toThrow(/mid-turn/)
    expect(registry.get(desc.id)?.promptDedupe).toBeUndefined()

    release()
    await vi.waitFor(() => expect(registry.get(desc.id)?.busy).toBe(false))
    const retried = await registry.enqueuePrompt(desc.id, "retried", { dedupeKey: "retry-key" })
    expect(retried).toMatchObject({ delivery: "delivered", pending: false })
    await vi.waitFor(() => expect(prompts.length).toBe(2))
    expect(prompts.length).toBe(2)
    registry.shutdown()
  })

  it("ignores and drops a key older than the TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-27T00:00:00.000Z"))
    const registry = createSessionsRegistry({ persist: false })
    const { agent, prompts, release } = hangingAgent()
    const desc = spawn(registry, agent)

    await registry.enqueuePrompt(desc.id, "start", {})
    const first = await registry.enqueuePrompt(desc.id, "first", {
      queue: true,
      dedupeKey: "ttl-key",
    })
    expect(first.delivery).toBe("queued-mid-turn")

    vi.setSystemTime(new Date(Date.now() + PROMPT_DEDUPE_TTL_MS + 1))
    const second = await registry.enqueuePrompt(desc.id, "second", {
      queue: true,
      dedupeKey: "ttl-key",
    })
    expect(second.delivery).toBe("queued-mid-turn")
    expect(registry.get(desc.id)?.promptDedupe).toHaveLength(1)
    expect(prompts.length).toBe(1)

    release()
    registry.shutdown()
  })

  it("evicts the oldest key past the bound; the newest is still a duplicate", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { agent, release } = hangingAgent()
    const desc = spawn(registry, agent)

    await registry.enqueuePrompt(desc.id, "start", {})
    for (let i = 0; i <= PROMPT_DEDUPE_MAX; i++) {
      await registry.enqueuePrompt(desc.id, `queued-${i}`, {
        queue: true,
        dedupeKey: `key-${i}`,
      })
    }

    const entries = registry.get(desc.id)?.promptDedupe ?? []
    expect(entries).toHaveLength(PROMPT_DEDUPE_MAX)
    expect(entries.some(entry => entry.key === "key-0")).toBe(false)
    expect(entries.some(entry => entry.key === `key-${PROMPT_DEDUPE_MAX}`)).toBe(true)

    const oldest = await registry.enqueuePrompt(desc.id, "oldest-again", {
      queue: true,
      dedupeKey: "key-0",
    })
    expect(oldest.delivery).toBe("queued-mid-turn")

    const newest = await registry.enqueuePrompt(desc.id, "newest-again", {
      queue: true,
      dedupeKey: `key-${PROMPT_DEDUPE_MAX}`,
    })
    expect(newest).toMatchObject({
      delivery: "duplicate",
      duplicate: true,
      pending: false,
    })

    release()
    registry.shutdown()
  })

  it("persists the window and the waiting item's key across a restart", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "prompt-dedupe-"))
    tmpDirs.push(tmp)
    const persistPath = join(tmp, "sessions.json")

    const registry1 = createSessionsRegistry({ persistPath })
    const { agent } = hangingAgent()
    const desc = spawn(registry1, agent)
    await registry1.enqueuePrompt(desc.id, "start", {})
    const queued = await registry1.enqueuePrompt(desc.id, "waiting", {
      queue: true,
      dedupeKey: "restart-key",
    })
    expect(queued.delivery).toBe("queued-mid-turn")
    registry1.shutdown()

    const persisted = JSON.parse(readFileSync(persistPath, "utf8")) as {
      sessions: SessionDescriptor[]
    }
    const row = persisted.sessions.find(session => session.id === desc.id)
    expect(row?.promptQueue?.[0]?.dedupeKey).toBe("restart-key")
    expect(row?.promptDedupe?.some(entry => entry.key === "restart-key")).toBe(true)

    const registry2 = createSessionsRegistry({ persistPath })
    expect(registry2.get(desc.id)?.promptQueue?.[0]?.dedupeKey).toBe("restart-key")
    const duplicate = await registry2.enqueuePrompt(desc.id, "again", {
      dedupeKey: "restart-key",
    })
    expect(duplicate).toMatchObject({
      queued: false,
      delivery: "duplicate",
      duplicate: true,
      pending: false,
      queueId: queued.queueId,
    })
    registry2.shutdown()
  })

  it("rejects an empty (after trim) key and a 201 character key without delivering", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { agent, prompts } = countingAgent()
    const desc = spawn(registry, agent)

    await expect(
      registry.enqueuePrompt(desc.id, "blank", { dedupeKey: "   " }),
    ).rejects.toThrow("enqueuePrompt: dedupeKey must be 1 to 200 characters")
    await expect(
      registry.enqueuePrompt(desc.id, "long", { dedupeKey: "a".repeat(201) }),
    ).rejects.toThrow("enqueuePrompt: dedupeKey must be 1 to 200 characters")

    expect(registry.get(desc.id)?.promptDedupe).toBeUndefined()
    expect(prompts.length).toBe(0)
    registry.shutdown()
  })

  it("refuses a dedupeKey together with a typed envelope, so no sender trace can leak", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { agent, prompts } = countingAgent()
    const desc = spawn(registry, agent)

    await expect(
      registry.enqueuePrompt(desc.id, "typed", {
        dedupeKey: "env-key",
        envelope: {
          id: "msg_test0001",
          ts: "2026-01-01T00:00:00.000Z",
          to: desc.id,
          from: { sessionId: "parent-session", relation: "parent" },
          kind: "report",
          urgency: "next-turn",
          text: "typed",
        },
      }),
    ).rejects.toThrow("enqueuePrompt: dedupeKey is not supported with a typed envelope message")

    expect(registry.get(desc.id)?.promptDedupe).toBeUndefined()
    expect(prompts.length).toBe(0)
    registry.shutdown()
  })

  it("removing a waiting keyed item does not free its key", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { agent, release } = hangingAgent()
    const desc = spawn(registry, agent)

    await registry.enqueuePrompt(desc.id, "start", {})
    const queued = await registry.enqueuePrompt(desc.id, "waiting", {
      queue: true,
      dedupeKey: "cancel-key",
    })
    expect(registry.removeQueuedPrompt(desc.id, queued.queueId!)).toEqual({ removed: true })
    expect(registry.get(desc.id)?.promptQueue).toHaveLength(0)

    const retried = await registry.enqueuePrompt(desc.id, "retry", {
      queue: true,
      dedupeKey: "cancel-key",
    })
    expect(retried).toMatchObject({
      queued: false,
      delivery: "duplicate",
      duplicate: true,
      pending: false,
    })
    expect(retried.queueId).toBeUndefined()

    release()
    registry.shutdown()
  })

  it("coalesce-in-place records the new key but keeps the original item's key", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { agent, release } = hangingAgent()
    const desc = spawn(registry, agent)

    await registry.enqueuePrompt(desc.id, "start", {})
    await registry.enqueuePrompt(desc.id, "first", {
      queue: true,
      coalesceKey: "coalesce",
      dedupeKey: "original-key",
    })
    await registry.enqueuePrompt(desc.id, "second", {
      queue: true,
      coalesceKey: "coalesce",
      dedupeKey: "replacement-key",
    })

    const queue = registry.get(desc.id)?.promptQueue ?? []
    expect(queue).toHaveLength(1)
    expect(queue[0]?.dedupeKey).toBe("original-key")
    expect(registry.get(desc.id)?.promptDedupe?.map(entry => entry.key)).toEqual([
      "original-key",
      "replacement-key",
    ])

    const replacementRetry = await registry.enqueuePrompt(desc.id, "third", {
      queue: true,
      coalesceKey: "coalesce",
      dedupeKey: "replacement-key",
    })
    expect(replacementRetry).toMatchObject({ delivery: "duplicate", duplicate: true })

    const originalRetry = await registry.enqueuePrompt(desc.id, "fourth", {
      queue: true,
      coalesceKey: "coalesce",
      dedupeKey: "original-key",
    })
    expect(originalRetry).toMatchObject({ delivery: "duplicate", duplicate: true })

    release()
    registry.shutdown()
  })
})
