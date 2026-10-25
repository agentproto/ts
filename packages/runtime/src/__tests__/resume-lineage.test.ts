/**
 * Every path that revives an ended session as a NEW descriptor must record
 * lineage (`continuedFrom` on the new row, `continuedTo` back on the old one)
 * so list/tree consumers can group the ids of one conversation. Covers the
 * cron `prompt-session` path, the sentinel dead-session path (wired exactly
 * like index.ts's `restartInboundSession`), and a direct spawn that reattaches
 * an adapter-native conversation another row already owns.
 */

import "../sentinel-platform.js"

import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createCronScheduler } from "../cron-scheduler.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent, type SessionsRegistry } from "../sessions.js"
import { restartAgentSession } from "../session-restart-core.js"
import { spawnAgentSession } from "../session-spawn.js"
import { createSentinelStore } from "@agentproto/sentinel"
import { createSentinelRuntime } from "@agentproto/sentinel"
import { createFakeSentinelProvider, makeFakeEvent } from "@agentproto/sentinel"
import { singleMatch } from "@agentproto/sentinel"
import type { AgentAdapterResolver } from "../http-server.js"

let counter = 0
function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `acp_${counter++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function makeResolver() {
  const startSession = vi.fn(async (_opts: unknown) => fakeAgentSession())
  const resolveAgentAdapter: AgentAdapterResolver = async () => ({
    startSession: startSession as never,
    commandPreview: "mock-adapter",
  })
  return { resolveAgentAdapter, startSession }
}

function endedSession(registry: SessionsRegistry) {
  const prev = registry.spawnAgent({
    workspaceSlug: "default",
    cwd: process.cwd(),
    agentSession: fakeAgentSession(),
    adapterSlug: "mock-adapter",
    label: "the conversation",
  })
  registry.kill(prev.id)
  return prev
}

describe("revival lineage (continuedFrom)", () => {
  it("cron prompt-session: reviving a dead session records continuedFrom/continuedTo", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "resume-lineage-cron-"))
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ persist: false, sessionEvents })
    const { resolveAgentAdapter } = makeResolver()
    const prev = endedSession(registry)
    // A pid-less ACP row never reads `processAlive: false`; project it so the
    // scheduler takes the revive branch (a pid-bearing dead session does).
    const view = { ...registry, get: (id: string) => {
      const d = registry.get(id)
      return d && id === prev.id ? { ...d, processAlive: false } : d
    } } as SessionsRegistry
    const scheduler = createCronScheduler({ sessionEvents, registry: view, resolveAgentAdapter, workspace })
    try {
      const job = await scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: { kind: "prompt-session", sessionId: prev.id, prompt: "wake up" },
      })
      const result = await scheduler.run(job.id)
      expect(result?.ok).toBe(true)
      const revived = registry.list().find(s => s.id !== prev.id)!
      expect(revived.continuedFrom).toBe(prev.id)
      expect(revived.resumedFrom).toBe(prev.id)
      expect(revived.label).toBe("the conversation")
      // First revival of a base session starts the lineage count at 1.
      expect(revived.continuationGeneration).toBe(1)
      expect(registry.get(prev.id)?.continuedTo).toBe(revived.id)
    } finally {
      scheduler.shutdown()
      registry.shutdown()
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it("chained revival: reviving a revived row carries the count to generation 2", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "resume-lineage-chain-"))
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ persist: false, sessionEvents })
    const { resolveAgentAdapter } = makeResolver()
    const base = endedSession(registry)

    // Same cron revive as above, pointed at whichever row this hop starts from
    // (each hop needs its own `processAlive: false` projection).
    const reviveOnce = async (targetId: string) => {
      const view = { ...registry, get: (id: string) => {
        const d = registry.get(id)
        return d && id === targetId ? { ...d, processAlive: false } : d
      } } as SessionsRegistry
      const scheduler = createCronScheduler({ sessionEvents, registry: view, resolveAgentAdapter, workspace })
      try {
        const job = await scheduler.create({
          schedule: "0 0 1 1 *",
          recurring: true,
          action: { kind: "prompt-session", sessionId: targetId, prompt: "wake up" },
        })
        const result = await scheduler.run(job.id)
        expect(result?.ok).toBe(true)
        return registry.list().find(s => s.continuedFrom === targetId)!
      } finally {
        scheduler.shutdown()
      }
    }

    try {
      const first = await reviveOnce(base.id)
      expect(first.continuationGeneration).toBe(1)

      registry.kill(first.id)
      const second = await reviveOnce(first.id)
      expect(second.continuedFrom).toBe(first.id)
      // The second hop reads the FIRST hop's generation off the resident row —
      // reviving a revived row continues the chain instead of restarting at 1.
      expect(second.continuationGeneration).toBe(2)
      expect(registry.get(first.id)?.continuedTo).toBe(second.id)
    } finally {
      registry.shutdown()
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it("sentinel dead-session path: the resumed row records continuedFrom", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { resolveAgentAdapter } = makeResolver()
    const prev = endedSession(registry)

    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider()
    store.create({
      provider: "fake",
      handle: { provider: "fake", remoteId: "fake:widget-1", cursor: "0" },
      spec: {
        match: singleMatch("fake:widget-1"),
        until: { kind: "never" },
        target: { kind: "session", sessionId: prev.id, urgency: "fyi" },
      },
    })
    provider.emit(makeFakeEvent({ id: "evt_1", type: "fake.widget.created", subject: "fake:widget-1" }))

    const runtime = createSentinelRuntime({
      store,
      registry,
      resolveProvider: async slug => (slug === "fake" ? provider : null),
      // index.ts: `processAlive !== false`; a dead pid-bearing row reads false.
      isSessionAlive: () => false,
      restartSession: async id => {
        const desc = registry.get(id)!
        return (await restartAgentSession(registry, resolveAgentAdapter, desc, { forceAgentResume: true })).desc.id
      },
      parkedPath: join(mkdtempSync(join(tmpdir(), "resume-lineage-park-")), "parked.jsonl"),
      log: () => undefined,
    })
    await runtime.pollOnce()

    const revived = registry.list().find(s => s.id !== prev.id)!
    expect(revived.continuedFrom).toBe(prev.id)
    expect(registry.get(prev.id)?.continuedTo).toBe(revived.id)
    registry.shutdown()
  })

  it("direct spawn with resumeSessionId that another row owns: lineage is recorded", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { resolveAgentAdapter } = makeResolver()
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession(),
      adapterSlug: "mock-adapter",
    })
    prev.adapterSessionId = "native-conv-1"
    registry.kill(prev.id)

    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter },
      { adapter: "mock-adapter", cwd: process.cwd(), resumeSessionId: "native-conv-1" } as never,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.descriptor.continuedFrom).toBe(prev.id)
    expect(registry.get(prev.id)?.continuedTo).toBe(result.descriptor.id)

    const unrelated = await spawnAgentSession(
      { registry, resolveAgentAdapter },
      { adapter: "mock-adapter", cwd: process.cwd(), resumeSessionId: "someone-elses-conv" } as never,
    )
    expect(unrelated.ok).toBe(true)
    if (unrelated.ok) expect(unrelated.descriptor.continuedFrom).toBeUndefined()
    registry.shutdown()
  })
})

/** `agent_start`'s internal `resumeSessionId` (the box re-attach path): a
 *  resume id naming a ROW on this daemon resolves to that row's adapter
 *  conversation + isolated config dir; rejections fall back to a fresh
 *  spawn that never claims continuity. */
describe("agent_start resume target resolution", () => {
  function resolverWith(
    startSession: (opts: Record<string, unknown>) => Promise<AgentSessionLike>,
  ): { resolveAgentAdapter: AgentAdapterResolver; starts: Array<Record<string, unknown>> } {
    const starts: Array<Record<string, unknown>> = []
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession: (async (opts: Record<string, unknown>) => {
        starts.push(opts)
        return startSession(opts)
      }) as never,
      commandPreview: "mock-adapter",
    })
    return { resolveAgentAdapter, starts }
  }

  it("a resumeSessionId naming a ROW resumes that row's conversation with its isolated config dir", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { resolveAgentAdapter, starts } = resolverWith(async () => fakeAgentSession())
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession(),
      adapterSlug: "mock-adapter",
      adapterConfigDir: "/tmp/cfg-abc",
    })
    registry.kill(prev.id)

    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter },
      { adapter: "mock-adapter", cwd: process.cwd(), resumeSessionId: prev.id } as never,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(starts).toHaveLength(1)
    // The ROW id resolves to the row's ADAPTER conversation id…
    expect(starts[0]?.resumeSessionId).toBe(prev.adapterSessionId)
    // …with the row's isolated config dir (the provider's conversation
    // store lives inside it), never a fresh one for the new id.
    expect(starts[0]?.configDir).toBe("/tmp/cfg-abc")
    expect(result.descriptor.resumeVia).toBe("resumed via ACP")
    expect(result.descriptor.resumedFrom).toBe(prev.id)
    registry.shutdown()
  })

  it("a row with no recorded adapter conversation drops the resume (blank spawn, no continuity claim)", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { resolveAgentAdapter, starts } = resolverWith(async () => fakeAgentSession())
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession(),
      adapterSlug: "mock-adapter",
      adapterConfigDir: "/tmp/cfg-abc",
    })
    registry.get(prev.id)!.adapterSessionId = ""
    registry.kill(prev.id)

    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter },
      { adapter: "mock-adapter", cwd: process.cwd(), resumeSessionId: prev.id } as never,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(starts).toHaveLength(1)
    expect(starts[0]?.resumeSessionId).toBeUndefined()
    expect(result.descriptor.resumeVia).toBeUndefined()
    registry.shutdown()
  })

  it("an adapter rejection of the resume id retries fresh and claims no continuity", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { resolveAgentAdapter, starts } = resolverWith(async opts => {
      if (opts.resumeSessionId) {
        // The ACP-level rejection shape (RESUME_ID_REJECTED_RE).
        throw new Error(`Resource not found (session ${String(opts.resumeSessionId)})`)
      }
      return fakeAgentSession()
    })
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession(),
      adapterSlug: "mock-adapter",
      adapterConfigDir: "/tmp/cfg-old",
    })
    registry.kill(prev.id)

    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter },
      { adapter: "mock-adapter", cwd: process.cwd(), resumeSessionId: prev.id } as never,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(starts).toHaveLength(2)
    expect(starts[0]?.resumeSessionId).toBe(prev.adapterSessionId)
    expect(starts[0]?.configDir).toBe("/tmp/cfg-old")
    // The retry: no resume id, a FRESH config dir — the rejected id's store
    // is exactly the one that couldn't be rehydrated.
    expect(starts[1]?.resumeSessionId).toBeUndefined()
    expect(starts[1]?.configDir).not.toBe("/tmp/cfg-old")
    // A fallback fresh spawn never wears a phantom resume claim.
    expect(result.descriptor.resumeVia).toBeUndefined()
    expect(result.descriptor.resumedFrom).toBeUndefined()
    registry.shutdown()
  })
})
