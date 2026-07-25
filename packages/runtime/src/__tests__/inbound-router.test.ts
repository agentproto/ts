import { describe, it, expect, vi } from "vitest"
import { routeInboundMessage } from "../inbound-router.js"
import type { InboundMessage, InboundRouterDeps } from "../inbound-router.js"
import type { TransmitterBinding, TransmitterBindingStore } from "../transmitter-bindings.js"

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
    expect(enqueuePrompt).toHaveBeenCalledWith("sess_1", msg.text)
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
    expect(enqueuePrompt).toHaveBeenCalledWith("sess_1-restarted", msg.text)
    expect(upsert).toHaveBeenCalledWith({
      alias: "agentpush",
      source: "+33600000000",
      contactRef: "alice",
      sessionId: "sess_1-restarted",
      mode: "route",
    })
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
