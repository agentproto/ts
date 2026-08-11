/**
 * WP-6 — AgentprotoSignalProvider against a fake `DaemonClient` and a fake
 * connected agent: watch → notify with correct dedupeKey/target, cursor
 * advancement (no double-notify), status-diff exit detection, per-subscription
 * poll error isolation, warn-once dedupe, and the `watch_session` /
 * `unwatch_session` tools' thread resolution.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Agent } from "@mastra/core/agent"
import type { DaemonClient, PollEventsResult } from "../daemon-client.js"
import { AgentprotoSignalProvider, EXIT_STATUSES, WATCHED_EVENT_KINDS } from "../signal-provider.js"

interface NotifyCall {
  notification: Record<string, unknown>
  target: Record<string, unknown>
}

/** The one agent method the provider's `notify` calls. */
function fakeAgent(): { agent: Agent; calls: NotifyCall[] } {
  const calls: NotifyCall[] = []
  const agent = {
    sendNotificationSignal: async (notification: Record<string, unknown>, target: Record<string, unknown>) => {
      calls.push({ notification, target })
      return {}
    },
  } as unknown as Agent
  return { agent, calls }
}

interface FakeDaemon {
  client: DaemonClient
  /** Scripted per-session event batches — each pollEvents call shifts one. */
  eventBatches: Map<string, PollEventsResult[]>
  /** Scripted session rows returned by every listSessions call. */
  sessions: Array<Record<string, unknown>>
  pollCalls: Array<{ sessionId: string; since: number | undefined; types: string[] | undefined }>
  listCalls: number
  failPollFor: Set<string>
  failList: boolean
}

function fakeDaemon(): FakeDaemon {
  const fake: FakeDaemon = {
    client: undefined as unknown as DaemonClient,
    eventBatches: new Map(),
    sessions: [],
    pollCalls: [],
    listCalls: 0,
    failPollFor: new Set(),
    failList: false,
  }
  fake.client = {
    pollEvents: async (
      sessionId: string,
      opts: { since?: number; types?: string[] } = {},
    ): Promise<PollEventsResult> => {
      fake.pollCalls.push({ sessionId, since: opts.since, types: opts.types })
      if (fake.failPollFor.has(sessionId)) throw new Error(`poll boom for ${sessionId}`)
      const batches = fake.eventBatches.get(sessionId)
      const batch = batches?.shift()
      return batch ?? { sessionId, events: [], nextSeq: opts.since ?? 0, complete: true }
    },
    listSessions: async () => {
      fake.listCalls += 1
      if (fake.failList) throw new Error("list boom")
      return { sessions: fake.sessions }
    },
  } as unknown as DaemonClient
  return fake
}

/** Exposes the base class's protected subscription accessor for tests. */
class TestProvider extends AgentprotoSignalProvider {
  subs() {
    return this.getSubscriptions()
  }
}

const TARGET = { threadId: "thread-1", resourceId: "mastra-agent" }

function makeProvider(fake: FakeDaemon) {
  const provider = new TestProvider({ client: fake.client })
  const { agent, calls } = fakeAgent()
  provider.connect(agent)
  return { provider, notifyCalls: calls }
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("AgentprotoSignalProvider — event polling", () => {
  it("watch → scripted turn-end event → notify with dedupeKey, target, and payload", async () => {
    const fake = fakeDaemon()
    fake.sessions = [{ id: "sess-1", status: "running", label: "builder" }]
    fake.eventBatches.set("sess-1", [
      { sessionId: "sess-1", events: [{ seq: 7, kind: "turn-end", reason: "completed" }], nextSeq: 7, complete: true },
    ])
    const { provider, notifyCalls } = makeProvider(fake)
    provider.watch(TARGET, "sess-1")

    await provider.poll(provider.subs())

    expect(notifyCalls).toHaveLength(1)
    expect(notifyCalls[0]!.notification).toMatchObject({
      source: "agentproto-daemon",
      kind: "turn-end",
      priority: "medium",
      summary: "Session sess-1 (builder): turn-end",
      dedupeKey: "agentproto-daemon:sess-1:7",
      payload: { seq: 7, kind: "turn-end", reason: "completed" },
    })
    expect(notifyCalls[0]!.target).toMatchObject({ threadId: "thread-1", resourceId: "mastra-agent" })
    // The events fetch asked for exactly the watched kinds.
    expect(fake.pollCalls[0]!.types).toEqual([...WATCHED_EVENT_KINDS])
  })

  it("error events notify with priority high", async () => {
    const fake = fakeDaemon()
    fake.eventBatches.set("sess-1", [
      { sessionId: "sess-1", events: [{ seq: 3, kind: "error", error: "boom" }], nextSeq: 3, complete: true },
    ])
    const { provider, notifyCalls } = makeProvider(fake)
    provider.watch(TARGET, "sess-1")

    await provider.poll(provider.subs())

    expect(notifyCalls[0]!.notification.priority).toBe("high")
  })

  it("cursor advances across cycles: the same event is never fetched twice", async () => {
    const fake = fakeDaemon()
    fake.eventBatches.set("sess-1", [
      { sessionId: "sess-1", events: [{ seq: 5, kind: "turn-end" }], nextSeq: 5, complete: true },
    ])
    const { provider, notifyCalls } = makeProvider(fake)
    provider.watch(TARGET, "sess-1")

    await provider.poll(provider.subs())
    await provider.poll(provider.subs())

    expect(fake.pollCalls.map((c) => c.since)).toEqual([undefined, 5])
    expect(notifyCalls).toHaveLength(1)
    expect(provider.subs()[0]!.metadata.cursor).toBe(5)
  })

  it("re-delivery of the same seq (e.g. after in-process cursor loss) reuses the same dedupeKey", async () => {
    const fake = fakeDaemon()
    const batch = (): PollEventsResult => ({
      sessionId: "sess-1",
      events: [{ seq: 5, kind: "turn-end" }],
      nextSeq: 5,
      complete: true,
    })
    fake.eventBatches.set("sess-1", [batch(), batch()])
    const { provider, notifyCalls } = makeProvider(fake)
    provider.watch(TARGET, "sess-1")

    await provider.poll(provider.subs())
    // Simulate a restart-shaped replay: cursor wiped, daemon replays seq 5.
    delete provider.subs()[0]!.metadata.cursor
    await provider.poll(provider.subs())

    expect(notifyCalls).toHaveLength(2)
    // Identical dedupeKey both times — the notifications storage coalesces
    // on it, which is what makes the replay harmless.
    expect(notifyCalls[0]!.notification.dedupeKey).toBe("agentproto-daemon:sess-1:5")
    expect(notifyCalls[1]!.notification.dedupeKey).toBe("agentproto-daemon:sess-1:5")
  })
})

describe("AgentprotoSignalProvider — status-diff exit detection", () => {
  it("running → exited transition notifies exactly once, with the :exited dedupeKey", async () => {
    const fake = fakeDaemon()
    fake.sessions = [{ id: "sess-1", status: "running" }]
    const { provider, notifyCalls } = makeProvider(fake)
    provider.watch(TARGET, "sess-1")

    await provider.poll(provider.subs())
    expect(notifyCalls).toHaveLength(0)

    fake.sessions = [{ id: "sess-1", status: "exited", exitCode: 0 }]
    await provider.poll(provider.subs())
    expect(notifyCalls).toHaveLength(1)
    expect(notifyCalls[0]!.notification).toMatchObject({
      kind: "exited",
      priority: "medium",
      dedupeKey: "agentproto-daemon:sess-1:exited",
      summary: "Session sess-1: exited (status exited)",
    })

    // Still exited on the next cycle → no second notification.
    await provider.poll(provider.subs())
    expect(notifyCalls).toHaveLength(1)
  })

  it("error status and nonzero exitCode raise exit priority to high", async () => {
    for (const row of [
      { id: "s-err", status: "error" },
      { id: "s-code", status: "exited", exitCode: 1 },
    ]) {
      const fake = fakeDaemon()
      fake.sessions = [row]
      const { provider, notifyCalls } = makeProvider(fake)
      provider.watch(TARGET, row.id as string)

      await provider.poll(provider.subs())

      expect(EXIT_STATUSES.has(row.status as string)).toBe(true)
      expect(notifyCalls).toHaveLength(1)
      expect(notifyCalls[0]!.notification.priority).toBe("high")
    }
  })

  it("lists sessions once per poll cycle, not once per subscription", async () => {
    const fake = fakeDaemon()
    fake.sessions = [
      { id: "a", status: "running" },
      { id: "b", status: "running" },
    ]
    const { provider } = makeProvider(fake)
    provider.watch(TARGET, "a")
    provider.watch(TARGET, "b")

    await provider.poll(provider.subs())

    expect(fake.listCalls).toBe(1)
  })
})

describe("AgentprotoSignalProvider — error isolation", () => {
  it("one subscription's poll failure doesn't stop the others", async () => {
    const fake = fakeDaemon()
    fake.failPollFor.add("bad")
    fake.eventBatches.set("good", [
      { sessionId: "good", events: [{ seq: 1, kind: "turn-end" }], nextSeq: 1, complete: true },
    ])
    const { provider, notifyCalls } = makeProvider(fake)
    provider.watch(TARGET, "bad")
    provider.watch(TARGET, "good")

    await provider.poll(provider.subs())

    expect(notifyCalls).toHaveLength(1)
    expect(notifyCalls[0]!.notification.dedupeKey).toBe("agentproto-daemon:good:1")
  })

  it("repeated identical failures warn once, not once per cycle", async () => {
    const fake = fakeDaemon()
    fake.failPollFor.add("bad")
    const { provider } = makeProvider(fake)
    provider.watch(TARGET, "bad")

    await provider.poll(provider.subs())
    await provider.poll(provider.subs())
    await provider.poll(provider.subs())

    const warns = vi.mocked(console.warn).mock.calls.filter((c) => String(c[0]).includes("session bad"))
    expect(warns).toHaveLength(1)
  })

  it("listSessions failure skips exit detection but still polls events, and never throws", async () => {
    const fake = fakeDaemon()
    fake.failList = true
    fake.eventBatches.set("sess-1", [
      { sessionId: "sess-1", events: [{ seq: 2, kind: "turn-end" }], nextSeq: 2, complete: true },
    ])
    const { provider, notifyCalls } = makeProvider(fake)
    provider.watch(TARGET, "sess-1")

    await expect(provider.poll(provider.subs())).resolves.toBeUndefined()
    expect(notifyCalls).toHaveLength(1)
  })
})

describe("AgentprotoSignalProvider — watch_session / unwatch_session tools", () => {
  function callTool(
    tool: { execute?: unknown },
    input: unknown,
    context: unknown = {},
  ): Promise<unknown> {
    return (tool.execute as (input: unknown, context: unknown) => Promise<unknown>)(input, context)
  }

  it("exposes both tools, ids matching tool-categories.ts", () => {
    const { provider } = makeProvider(fakeDaemon())
    expect(Object.keys(provider.getTools()).sort()).toEqual(["unwatch_session", "watch_session"])
  })

  it("watch_session resolves the target thread from the tool execution context", async () => {
    const fake = fakeDaemon()
    fake.eventBatches.set("sess-9", [
      { sessionId: "sess-9", events: [{ seq: 1, kind: "turn-end" }], nextSeq: 1, complete: true },
    ])
    const { provider, notifyCalls } = makeProvider(fake)
    const tools = provider.getTools()

    const result = await callTool(
      tools.watch_session!,
      { sessionId: "sess-9", label: "worker" },
      { agent: { threadId: "ctx-thread", resourceId: "ctx-resource" } },
    )
    expect(result).toEqual({ subscribed: true, sessionId: "sess-9", threadId: "ctx-thread" })

    await provider.poll(provider.subs())
    expect(notifyCalls[0]!.target).toMatchObject({
      threadId: "ctx-thread",
      resourceId: "ctx-resource",
      // Watch subscriptions never wake an idle thread — ACP has no surface
      // to stream an unprompted background run.
      ifIdle: { behavior: "persist" },
    })
    expect(notifyCalls[0]!.notification.summary).toBe("Session sess-9 (worker): turn-end")
  })

  it("watch_session without thread context and without explicit ids fails with a clear message", async () => {
    const { provider } = makeProvider(fakeDaemon())
    const tools = provider.getTools()
    await expect(callTool(tools.watch_session!, { sessionId: "s" })).rejects.toThrow(
      /pass threadId and resourceId explicitly/,
    )
  })

  it("unwatch_session removes the subscription made by watch_session", async () => {
    const { provider } = makeProvider(fakeDaemon())
    const tools = provider.getTools()
    const context = { agent: { threadId: "t", resourceId: "r" } }

    await callTool(tools.watch_session!, { sessionId: "s-1" }, context)
    expect(provider.subs()).toHaveLength(1)

    const result = await callTool(tools.unwatch_session!, { sessionId: "s-1" }, context)
    expect(result).toEqual({ unsubscribed: true, sessionId: "s-1" })
    expect(provider.subs()).toHaveLength(0)

    // Unwatching again reports false instead of throwing.
    const again = await callTool(tools.unwatch_session!, { sessionId: "s-1" }, context)
    expect(again).toEqual({ unsubscribed: false, sessionId: "s-1" })
  })
})
