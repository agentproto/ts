import { describe, it, expect, vi } from "vitest"
import { routeInboundMessage, attributeInboundText } from "../inbound-router.js"
import type { InboundMessage, InboundRouterDeps } from "../inbound-router.js"
import type { TransmitterBinding, TransmitterBindingStore } from "../transmitter-bindings.js"
import { makeRestartForRouting } from "../index.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentSessionResumer } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

// ── Helpers ───────────────────────────────────────────────────────────

function makeMsg(overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    alias: "agentpush",
    source: "+33600000000",
    contactRef: "alice",
    text: "hello from alice",
    ...overrides,
  }
}

/** Minimal in-memory TransmitterBindingStore satisfying the frozen WP1 interface. */
function makeBindingStore(seed?: TransmitterBinding): {
  store: TransmitterBindingStore
  upsert: ReturnType<typeof vi.fn>
} {
  const map = new Map<string, TransmitterBinding>()
  const key = (alias: string, source: string, contactRef: string): string =>
    `${alias}:${source}:${contactRef}`

  if (seed) map.set(key(seed.alias, seed.source, seed.contactRef), seed)

  const upsert = vi.fn(
    (b: Omit<TransmitterBinding, "lastSeenTs"> & { lastSeenTs?: number }): TransmitterBinding => {
      const binding: TransmitterBinding = { ...b, lastSeenTs: b.lastSeenTs ?? 0 }
      map.set(key(b.alias, b.source, b.contactRef), binding)
      return binding
    },
  )

  return {
    store: {
      get: (alias, source, contactRef) => map.get(key(alias, source, contactRef)),
      upsert,
      remove: (alias, source, contactRef) => map.delete(key(alias, source, contactRef)),
      list: () => Array.from(map.values()),
    },
    upsert,
  }
}

function makeDeps(overrides?: Partial<InboundRouterDeps>): InboundRouterDeps {
  const { store } = makeBindingStore()
  return {
    bindings: store,
    enqueuePrompt: vi.fn(),
    isSessionAlive: vi.fn(() => true),
    restartSession: vi.fn(async (id: string) => `${id}-restarted`),
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("routeInboundMessage", () => {
  it('mode "spawn" always spawns, regardless of any existing binding', async () => {
    const { store } = makeBindingStore({
      alias: "agentpush",
      source: "+33600000000",
      contactRef: "alice",
      sessionId: "sess_1",
      mode: "route",
      lastSeenTs: 100,
    })
    const spawnForContact = vi.fn(async () => {})
    const deps = makeDeps({ bindings: store, spawnForContact })

    const result = await routeInboundMessage(deps, makeMsg(), "spawn")

    expect(result).toEqual({ action: "spawned" })
    expect(spawnForContact).toHaveBeenCalledTimes(1)
    expect(deps.enqueuePrompt).not.toHaveBeenCalled()
  })

  it('mode "spawn" without spawnForContact configured skips', async () => {
    const deps = makeDeps()

    const result = await routeInboundMessage(deps, makeMsg(), "spawn")

    expect(result).toEqual({ action: "skipped" })
  })

  it('mode "route" with a bound, alive session routes and refreshes the binding', async () => {
    const { store, upsert } = makeBindingStore({
      alias: "agentpush",
      source: "+33600000000",
      contactRef: "alice",
      sessionId: "sess_1",
      mode: "route-or-spawn",
      lastSeenTs: 100,
    })
    const enqueuePrompt = vi.fn()
    const isSessionAlive = vi.fn(() => true)
    const restartSession = vi.fn(async (id: string) => `${id}-restarted`)
    const deps = makeDeps({ bindings: store, enqueuePrompt, isSessionAlive, restartSession })

    const msg = makeMsg()
    const result = await routeInboundMessage(deps, msg, "route")

    expect(result).toEqual({ action: "routed", sessionId: "sess_1" })
    expect(isSessionAlive).toHaveBeenCalledWith("sess_1")
    expect(enqueuePrompt).toHaveBeenCalledWith("sess_1", msg.text, { queue: true })
    expect(restartSession).not.toHaveBeenCalled()
    expect(upsert).toHaveBeenCalledWith({
      alias: "agentpush",
      source: "+33600000000",
      contactRef: "alice",
      sessionId: "sess_1",
      mode: "route-or-spawn",
    })
  })

  it('refreshes a binding while preserving the existing provider field', async () => {
    const { store, upsert } = makeBindingStore({
      alias: "default",
      source: "123456789",
      contactRef: "123456789",
      sessionId: "sess_tg",
      mode: "route-or-spawn",
      provider: "telegram",
      lastSeenTs: 100,
    })
    const enqueuePrompt = vi.fn()
    const isSessionAlive = vi.fn(() => true)
    const deps = makeDeps({ bindings: store, enqueuePrompt, isSessionAlive })

    const msg = makeMsg({ alias: "default", source: "123456789", contactRef: "123456789" })
    const result = await routeInboundMessage(deps, msg, "route")

    expect(result).toEqual({ action: "routed", sessionId: "sess_tg" })
    expect(upsert).toHaveBeenCalledWith({
      alias: "default",
      source: "123456789",
      contactRef: "123456789",
      sessionId: "sess_tg",
      mode: "route-or-spawn",
      provider: "telegram",
    })
    const refreshed = store.get("default", "123456789", "123456789")
    expect(refreshed?.provider).toBe("telegram")
  })

  it('mode "route" with a bound, dead session restarts then routes', async () => {
    const { store, upsert } = makeBindingStore({
      alias: "agentpush",
      source: "+33600000000",
      contactRef: "alice",
      sessionId: "sess_1",
      mode: "route",
      lastSeenTs: 100,
    })
    const enqueuePrompt = vi.fn()
    const isSessionAlive = vi.fn(() => false)
    const restartSession = vi.fn(async (id: string) => `${id}-restarted`)
    const deps = makeDeps({ bindings: store, enqueuePrompt, isSessionAlive, restartSession })

    const msg = makeMsg()
    const result = await routeInboundMessage(deps, msg, "route")

    expect(result).toEqual({ action: "restarted-routed", sessionId: "sess_1-restarted" })
    expect(restartSession).toHaveBeenCalledWith("sess_1")
    expect(enqueuePrompt).toHaveBeenCalledWith("sess_1-restarted", msg.text, { queue: true })
    expect(upsert).toHaveBeenCalledWith({
      alias: "agentpush",
      source: "+33600000000",
      contactRef: "alice",
      sessionId: "sess_1-restarted",
      mode: "route",
    })
  })

  it('mode "route" with a dead bound session that resumes IN PLACE routes to the SAME id (no restarted-routed)', async () => {
    // PR C: the inbound restart now revives an ended-but-resumable row on
    // the SAME id, so the message is a plain "routed" — the binding is
    // already on the right session and no new conversation is started.
    const { store, upsert } = makeBindingStore({
      alias: "agentpush",
      source: "+33600000000",
      contactRef: "alice",
      sessionId: "sess_1",
      mode: "route",
      lastSeenTs: 100,
    })
    const enqueuePrompt = vi.fn()
    const isSessionAlive = vi.fn(() => false)
    const restartSession = vi.fn(async (id: string) => id)
    const deps = makeDeps({ bindings: store, enqueuePrompt, isSessionAlive, restartSession })

    const msg = makeMsg()
    const result = await routeInboundMessage(deps, msg, "route")

    expect(result).toEqual({ action: "routed", sessionId: "sess_1" })
    expect(restartSession).toHaveBeenCalledWith("sess_1")
    expect(enqueuePrompt).toHaveBeenCalledWith("sess_1", msg.text, { queue: true })
    expect(upsert).toHaveBeenCalledWith({
      alias: "agentpush",
      source: "+33600000000",
      contactRef: "alice",
      sessionId: "sess_1",
      mode: "route",
    })
  })

  it('mode "route" revives a DELIBERATELY-ended bound session IN PLACE (inbound = human intent)', async () => {
    // PR C follow-up: an inbound message is a human explicitly writing to
    // the session, so the restart hook index.ts wires for the inbound
    // watcher/push router passes allowDeliberateEnd:true — a deliberate end
    // (operator-completed / steward-*) is revived IN PLACE when the row is
    // resumable. This drives the REAL factory + registry, not a mock
    // restartSession: the router → restartInboundSession → restartPreferInPlace
    // chain is the production wiring.
    const resumeCalls: Array<string | undefined> = []
    const resumedSession = (id: string): AgentSessionLike => ({
      sessionId: id,
      async *send() {},
      async cancel() {},
      async close() {},
    })
    const resumeAgent: AgentSessionResumer = async ({ resumeSessionId }) => {
      resumeCalls.push(resumeSessionId)
      return resumedSession(`resumed_${resumeSessionId}`)
    }
    const registry = createSessionsRegistry({ persist: false, resumeAgent })
    const resolver: AgentAdapterResolver = async slug => ({
      async startSession() {
        return resumedSession(`spawn_${slug}`)
      },
      commandPreview: `mock-${slug}`,
    })
    const restartSession = makeRestartForRouting(
      { sessions: registry, resolveAgentAdapter: resolver },
      { name: "restartInboundSession", allowDeliberateEnd: true },
    )

    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: { sessionId: "acp_orig", async *send() {}, async cancel() {}, async close() {} },
      adapterSlug: "hermes",
    })
    // A deliberate end with a CLEARED binding (reapIdle clears it; the
    // relabel simulates the operator-completed stamp — the policy under test
    // is the flag, not the death mechanics).
    registry.reapIdle(prev.id)
    prev.endedReason = "operator-completed"
    // Captured BEFORE the route: a successful in-place resume REFRESHES
    // adapterSessionId onto the new ACP session id.
    const prevAcpId = prev.adapterSessionId

    const { store } = makeBindingStore({
      alias: "agentpush",
      source: "+33600000000",
      contactRef: "alice",
      sessionId: prev.id,
      mode: "route",
      lastSeenTs: 100,
    })
    const enqueuePrompt = vi.fn()
    const deps = makeDeps({
      bindings: store,
      enqueuePrompt,
      isSessionAlive: vi.fn(() => false),
      restartSession,
    })

    const msg = makeMsg()
    const result = await routeInboundMessage(deps, msg, "route")

    // Revived IN PLACE: same id, no new row, no restarted-routed.
    expect(result).toEqual({ action: "routed", sessionId: prev.id })
    expect(resumeCalls).toEqual([prevAcpId])
    expect(registry.list()).toHaveLength(1)
    expect(registry.get(prev.id)?.status).toBe("running")
    expect(enqueuePrompt).toHaveBeenCalledWith(prev.id, msg.text, { queue: true })

    registry.shutdown()
  })

  it('mode "route" with no binding skips without spawning', async () => {
    const spawnForContact = vi.fn(async () => {})
    const deps = makeDeps({ spawnForContact })

    const result = await routeInboundMessage(deps, makeMsg(), "route")

    expect(result).toEqual({ action: "skipped" })
    expect(spawnForContact).not.toHaveBeenCalled()
    expect(deps.enqueuePrompt).not.toHaveBeenCalled()
  })

  it('mode "route-or-spawn" with no binding falls back to spawn', async () => {
    const spawnForContact = vi.fn(async () => {})
    const deps = makeDeps({ spawnForContact })

    const result = await routeInboundMessage(deps, makeMsg(), "route-or-spawn")

    expect(result).toEqual({ action: "spawned" })
    expect(spawnForContact).toHaveBeenCalledTimes(1)
  })

  it('mode "route-or-spawn" with no binding and no spawnForContact configured skips', async () => {
    const deps = makeDeps()

    const result = await routeInboundMessage(deps, makeMsg(), "route-or-spawn")

    expect(result).toEqual({ action: "skipped" })
  })

  it('mode "route-or-spawn" with a bound, alive session routes instead of spawning', async () => {
    const { store } = makeBindingStore({
      alias: "agentpush",
      source: "+33600000000",
      contactRef: "alice",
      sessionId: "sess_1",
      mode: "route-or-spawn",
      lastSeenTs: 100,
    })
    const spawnForContact = vi.fn(async () => {})
    const deps = makeDeps({ bindings: store, spawnForContact, isSessionAlive: vi.fn(() => true) })

    const result = await routeInboundMessage(deps, makeMsg(), "route-or-spawn")

    expect(result).toEqual({ action: "routed", sessionId: "sess_1" })
    expect(spawnForContact).not.toHaveBeenCalled()
  })

  it("preserves the binding's provider when refreshing lastSeenTs", async () => {
    const { store, upsert } = makeBindingStore({
      alias: "telegram",
      source: "123456789",
      contactRef: "123456789",
      sessionId: "sess_1",
      mode: "route-or-spawn",
      provider: "telegram",
      lastSeenTs: 100,
    })
    const enqueuePrompt = vi.fn()
    const deps = makeDeps({
      bindings: store,
      enqueuePrompt,
      isSessionAlive: vi.fn(() => true),
    })

    const msg = makeMsg({ alias: "telegram", source: "123456789", contactRef: "123456789" })
    const result = await routeInboundMessage(deps, msg, "route")

    expect(result).toEqual({ action: "routed", sessionId: "sess_1" })
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        alias: "telegram",
        source: "123456789",
        contactRef: "123456789",
        sessionId: "sess_1",
        mode: "route-or-spawn",
        provider: "telegram",
      }),
    )
  })
})

describe("attributeInboundText", () => {
  it("returns msg.text unchanged when neither displayName nor surface is set", () => {
    const msg = makeMsg()
    expect(attributeInboundText(msg)).toBe("hello from alice")
  })

  it("returns msg.text unchanged when displayName and surface are present but blank", () => {
    // A caller with no identity to offer must not degrade the 1:1 path —
    // `""`/whitespace is treated as absent, so no `[ · ]` prefix appears.
    expect(attributeInboundText(makeMsg({ displayName: "" }))).toBe("hello from alice")
    expect(attributeInboundText(makeMsg({ surface: "   " }))).toBe("hello from alice")
    expect(attributeInboundText(makeMsg({ displayName: "  ", surface: "" }))).toBe("hello from alice")
  })

  it("prefixes [displayName] when only displayName is set", () => {
    const msg = makeMsg({ displayName: "Alice" })
    expect(attributeInboundText(msg)).toBe("[Alice] hello from alice")
  })

  it("prefixes [contactRef · surface] when only surface is set", () => {
    const msg = makeMsg({ surface: "telegram" })
    expect(attributeInboundText(msg)).toBe("[alice · telegram] hello from alice")
  })

  it("prefixes [displayName · surface] when both are set", () => {
    const msg = makeMsg({ displayName: "Alice", surface: "telegram" })
    expect(attributeInboundText(msg)).toBe("[Alice · telegram] hello from alice")
  })

  it("uses raw values verbatim — no truncation, lowercase, or rewrite", () => {
    const msg = makeMsg({ displayName: "  WeIrD   NAME  ", surface: "Telegram" })
    expect(attributeInboundText(msg)).toBe("[  WeIrD   NAME   · Telegram] hello from alice")
  })

  it("enqueues the ATTRIBUTED text into a bound session", async () => {
    const { store } = makeBindingStore({
      alias: "agentpush",
      source: "+33600000000",
      contactRef: "alice",
      sessionId: "sess_1",
      mode: "route",
      lastSeenTs: 100,
    })
    const enqueuePrompt = vi.fn()
    const deps = makeDeps({ bindings: store, enqueuePrompt, isSessionAlive: vi.fn(() => true) })

    await routeInboundMessage(deps, makeMsg({ displayName: "Alice", surface: "sms" }), "route")

    expect(enqueuePrompt).toHaveBeenCalledWith("sess_1", "[Alice · sms] hello from alice", {
      queue: true,
    })
  })

  it("still enqueues the raw text byte-for-byte when no attribution fields are present (1:1 regression guard)", async () => {
    const { store } = makeBindingStore({
      alias: "agentpush",
      source: "+33600000000",
      contactRef: "alice",
      sessionId: "sess_1",
      mode: "route",
      lastSeenTs: 100,
    })
    const enqueuePrompt = vi.fn()
    const deps = makeDeps({ bindings: store, enqueuePrompt, isSessionAlive: vi.fn(() => true) })

    const msg = makeMsg()
    await routeInboundMessage(deps, msg, "route")

    expect(enqueuePrompt).toHaveBeenCalledWith("sess_1", "hello from alice", { queue: true })
  })
})
