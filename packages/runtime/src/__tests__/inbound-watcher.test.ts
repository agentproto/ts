import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createInboundWatcher } from "../inbound-watcher.js"
import type { McpProxyRegistry } from "../mcp-proxy.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

// ── Helpers ───────────────────────────────────────────────────────────

/** Build a minimal MCP content response wrapping a JSON payload. */
function mcpOk(payload: unknown): { ok: true; result: unknown } {
  return {
    ok: true,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
  }
}

function mcpErr(msg: string): { ok: false; error: string } {
  return { ok: false, error: msg }
}

/** Build a DeliveryEvent-shaped inbound event. */
function makeEvent(
  contact_ref: string,
  timestamp: number,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return { contact_ref, timestamp, direction: "inbound", ...extra }
}

function makeMockRegistry(): SessionsRegistry {
  return {
    spawn: vi.fn(),
    register: vi.fn(),
    spawnAgent: vi.fn((input) => {
      const desc: SessionDescriptor = {
        id: `sess_${Math.random().toString(36).slice(2, 6)}`,
        kind: "agent-cli",
        workspaceSlug: "default",
        command: "mock",
        pid: null,
        status: "running",
        startedAt: new Date().toISOString(),
        cwd: input.cwd,
        label: input.label,
      }
      return desc
    }),
    spawnPty: vi.fn(),
    sendPrompt: vi.fn(async () => {}),
    enqueuePrompt: vi.fn(),
    list: vi.fn(() => []),
    get: vi.fn(),
    attach: vi.fn(() => null),
    attachPty: vi.fn(() => null),
    findByIdOrName: vi.fn(),
    writeTerminalInput: vi.fn(() => false),
    readTerminalOutput: vi.fn(() => null),
    kill: vi.fn(() => true),
    forget: vi.fn(() => true),
    shutdown: vi.fn(),
  } as unknown as SessionsRegistry
}

function makeMockAdapter(): AgentAdapterResolver {
  return vi.fn(async (_slug: string) => ({
    startSession: vi.fn(async () => ({
      sessionId: `adapter_${Math.random().toString(36).slice(2, 6)}`,
      send: async function* () {},
      cancel: async () => {},
      close: async () => {},
    })),
    commandPreview: "mock-adapter",
  }))
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("InboundWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("0 events → no spawn, cursor stays at 0", async () => {
    const callTool = vi.fn(async () => mcpOk({ events: [] }))
    const mcpProxy = { callTool } as unknown as McpProxyRegistry
    const registry = makeMockRegistry()
    const resolver = makeMockAdapter()

    const watcher = createInboundWatcher({
      mcpProxy,
      registry,
      resolveAgentAdapter: resolver,
      persist: false,
    })

    const desc = watcher.start({
      alias: "agentpush",
      source: "+33612345678",
      adapter: "claude-code",
      promptTemplate: "Inbound from {{contact_ref}}: {{messages_json}}",
      pollIntervalMs: 100,
    })

    expect(desc.status).toBe("running")
    expect(desc.cursor).toBe(0)

    await vi.advanceTimersByTimeAsync(150)

    expect(callTool).toHaveBeenCalledWith("agentpush", "poll_inbound", {
      source: "+33612345678",
    })
    expect(registry.spawnAgent).not.toHaveBeenCalled()
    expect(watcher.list()[0]?.cursor).toBe(0)
    expect(watcher.list()[0]?.spawned).toBe(0)

    watcher.stop(desc.watcherId)
  })

  it("2 events from 2 contacts → 2 spawns, cursor advances past max timestamp", async () => {
    const ev1 = makeEvent("alice", 1000)
    const ev2 = makeEvent("bob", 2000)

    const callTool = vi.fn(async () => mcpOk({ events: [ev1, ev2] }))
    const mcpProxy = { callTool } as unknown as McpProxyRegistry
    const registry = makeMockRegistry()
    const resolver = makeMockAdapter()

    const watcher = createInboundWatcher({
      mcpProxy,
      registry,
      resolveAgentAdapter: resolver,
      persist: false,
    })

    const desc = watcher.start({
      alias: "agentpush",
      source: "+33600000000",
      adapter: "claude-code",
      promptTemplate: "{{contact_ref}}: {{count}} msgs",
      pollIntervalMs: 100,
    })

    await vi.advanceTimersByTimeAsync(150)

    expect(registry.spawnAgent).toHaveBeenCalledTimes(2)

    // Cursor should be max(1000, 2000) + 1 = 2001
    const state = watcher.list()[0]!
    expect(state.cursor).toBe(2001)
    expect(state.spawned).toBe(2)
    expect(state.lastFireAt).toBeTruthy()

    watcher.stop(desc.watcherId)
  })

  it("2 events from same contact → 1 spawn with both events", async () => {
    const ev1 = makeEvent("carol", 500, { body: "hello" })
    const ev2 = makeEvent("carol", 600, { body: "world" })

    const callTool = vi.fn(async () => mcpOk({ events: [ev1, ev2] }))
    const mcpProxy = { callTool } as unknown as McpProxyRegistry
    const registry = makeMockRegistry()
    const resolver = makeMockAdapter()

    const watcher = createInboundWatcher({
      mcpProxy,
      registry,
      resolveAgentAdapter: resolver,
      persist: false,
    })

    const desc = watcher.start({
      alias: "agentpush",
      source: "carol-channel",
      adapter: "claude-code",
      promptTemplate: "msgs: {{messages_json}}",
      pollIntervalMs: 100,
    })

    await vi.advanceTimersByTimeAsync(150)

    // Only ONE spawn — both events batched for the same contact
    expect(registry.spawnAgent).toHaveBeenCalledTimes(1)

    const spawnCall = vi.mocked(registry.spawnAgent).mock.calls[0]![0]!
    expect(spawnCall.initialPrompt).toContain("carol")
    // Both events in the messages_json
    const prompt = spawnCall.initialPrompt as string
    expect(prompt).toContain("hello")
    expect(prompt).toContain("world")

    expect(watcher.list()[0]?.cursor).toBe(601)
    expect(watcher.list()[0]?.spawned).toBe(1)

    watcher.stop(desc.watcherId)
  })

  it("poll error → no spawn, cursor unchanged", async () => {
    const callTool = vi.fn(async () => mcpErr("upstream down"))
    const mcpProxy = { callTool } as unknown as McpProxyRegistry
    const registry = makeMockRegistry()
    const resolver = makeMockAdapter()

    const watcher = createInboundWatcher({
      mcpProxy,
      registry,
      resolveAgentAdapter: resolver,
      persist: false,
    })

    const desc = watcher.start({
      alias: "agentpush",
      source: "test",
      adapter: "claude-code",
      promptTemplate: "{{messages_json}}",
      pollIntervalMs: 100,
    })

    await vi.advanceTimersByTimeAsync(150)

    expect(registry.spawnAgent).not.toHaveBeenCalled()
    expect(watcher.list()[0]?.cursor).toBe(0)

    watcher.stop(desc.watcherId)
  })

  it("stop() halts polling", async () => {
    const callTool = vi.fn(async () => mcpOk({ events: [] }))
    const mcpProxy = { callTool } as unknown as McpProxyRegistry
    const registry = makeMockRegistry()
    const resolver = makeMockAdapter()

    const watcher = createInboundWatcher({
      mcpProxy,
      registry,
      resolveAgentAdapter: resolver,
      persist: false,
    })

    const desc = watcher.start({
      alias: "agentpush",
      source: "test",
      adapter: "claude-code",
      promptTemplate: "{{messages_json}}",
      pollIntervalMs: 100,
    })

    await vi.advanceTimersByTimeAsync(150)
    const callsBefore = callTool.mock.calls.length
    expect(callsBefore).toBeGreaterThan(0)

    const stopped = watcher.stop(desc.watcherId)
    expect(stopped).toBe(true)
    expect(watcher.list()[0]?.status).toBe("stopped")

    await vi.advanceTimersByTimeAsync(500)
    // No new calls after stop
    expect(callTool.mock.calls.length).toBe(callsBefore)
  })

  it("list() returns descriptor for all watchers", () => {
    const callTool = vi.fn(async () => mcpOk({ events: [] }))
    const mcpProxy = { callTool } as unknown as McpProxyRegistry
    const registry = makeMockRegistry()
    const resolver = makeMockAdapter()

    const watcher = createInboundWatcher({
      mcpProxy,
      registry,
      resolveAgentAdapter: resolver,
      persist: false,
    })

    watcher.start({ alias: "ap", source: "s1", adapter: "claude-code", promptTemplate: "x" })
    watcher.start({ alias: "ap", source: "s2", adapter: "claude-code", promptTemplate: "x" })

    const list = watcher.list()
    expect(list).toHaveLength(2)
    expect(list.map(w => w.source).sort()).toEqual(["s1", "s2"])

    watcher.shutdown()
  })
})
