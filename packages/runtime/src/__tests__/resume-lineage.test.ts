/**
 * Every path that revives an ended session as a NEW descriptor must record
 * lineage (`continuedFrom` on the new row, `continuedTo` back on the old one)
 * so list/tree consumers can group the ids of one conversation. Covers the
 * cron `prompt-session` path, the sentinel dead-session path (wired exactly
 * like index.ts's `restartInboundSession`), and a direct spawn that reattaches
 * an adapter-native conversation another row already owns.
 */

import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createCronScheduler } from "../cron-scheduler.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent, type SessionsRegistry } from "../sessions.js"
import { restartAgentSession } from "../session-restart-core.js"
import { spawnAgentSession } from "../session-spawn.js"
import { createSentinelStore } from "../sentinel-store.js"
import { createSentinelRuntime } from "../sentinel-runtime.js"
import { createFakeSentinelProvider, makeFakeEvent } from "../sentinel-providers/fake.js"
import { singleMatch } from "../sentinel-providers/types.js"
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
      expect(registry.get(prev.id)?.continuedTo).toBe(revived.id)
    } finally {
      scheduler.shutdown()
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
