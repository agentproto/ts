/**
 * Regression coverage for a production incident (2026-10): `POST
 * /sessions/:id/restart` (and the `session_restart` MCP verb, same shared
 * core) on an ALIVE agent-cli session minted a new id and:
 *
 *   1. dropped immutable spawn-time flags (`keepAlive`, `notifyParentOnCrash`,
 *      `sentinelAutoWatch`, `restartPolicy`) — a persistent supervisor
 *      restart became idle-reapable and lost its crash-detect opt-ins.
 *   2. copied `prev.mcpServers` verbatim, including the daemon's self-mount
 *      `ref` stamped `callerSessionId=<OLD id>` — every spawn/command the
 *      restarted session made through that mount misattributed to the dead
 *      session.
 *   3. left the OLD session alive (status running) — two live processes on
 *      the same conversation.
 *
 * These tests drive `restartAgentSession` (session-restart-core.ts) directly,
 * same style as session-restart-auth.test.ts, to isolate the fix from the
 * MCP/HTTP transport layer.
 */

import { describe, it, expect } from "vitest"

import { restartAgentSession } from "../session-restart-core.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent, RestartPolicy } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

let acpCounter = 0
function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `acp_${acpCounter++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

/** Records every `startSession` call's `mcpServers` so tests can assert on
 *  the identity stamp without spying on internals. */
function makeResolver(): {
  resolver: AgentAdapterResolver
  calls: Array<{ mcpServers?: unknown }>
} {
  const calls: Array<{ mcpServers?: unknown }> = []
  const resolver: AgentAdapterResolver = async () => ({
    async startSession(o: { mcpServers?: unknown }) {
      calls.push({ mcpServers: o.mcpServers })
      return fakeAgentSession()
    },
    commandPreview: "mock-adapter",
  })
  return { resolver, calls }
}

const NOOP_DEFAULTS = async () => undefined

describe("restartAgentSession — immutable spawn-time flags survive a restart", () => {
  const RESTART_POLICY: RestartPolicy = {
    on: ["crashed", "error"],
    maxRetries: 3,
    windowMs: 60_000,
    baseDelayMs: 1_000,
    factor: 2,
    maxDelayMs: 30_000,
  }

  it("carries keepAlive, notifyParentOnCrash, sentinelAutoWatch:false, and restartPolicy forward", async () => {
    const { resolver } = makeResolver()
    const registry = createSessionsRegistry({ persist: false })
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgentSession(),
      adapterSlug: "hermes",
      keepAlive: true,
      notifyParentOnCrash: true,
      sentinelAutoWatch: false,
      restartPolicy: RESTART_POLICY,
    })

    const restarted = await restartAgentSession(registry, resolver, prev, {
      forceAgentResume: true,
      loadDefaultsConfig: NOOP_DEFAULTS,
    })

    expect(restarted.desc.keepAlive).toBe(true)
    expect(restarted.desc.notifyParentOnCrash).toBe(true)
    expect(restarted.desc.sentinelAutoWatch).toBe(false)
    expect(restarted.desc.restartPolicy).toEqual(RESTART_POLICY)
  })

  it("omits the flags on the fresh descriptor when the prior session never had them (no accidental opt-in)", async () => {
    const { resolver } = makeResolver()
    const registry = createSessionsRegistry({ persist: false })
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgentSession(),
      adapterSlug: "hermes",
    })

    const restarted = await restartAgentSession(registry, resolver, prev, {
      forceAgentResume: true,
      loadDefaultsConfig: NOOP_DEFAULTS,
    })

    expect(restarted.desc.keepAlive).toBeUndefined()
    expect(restarted.desc.notifyParentOnCrash).toBeUndefined()
    expect(restarted.desc.sentinelAutoWatch).toBeUndefined()
    expect(restarted.desc.restartPolicy).toBeUndefined()
  })
})

describe("restartAgentSession — mcpServers callerSessionId identity stamp", () => {
  it("re-stamps the daemon self-mount with the FRESH session's id, dropping the OLD one, when daemonMcpUrl is known", async () => {
    const { resolver, calls } = makeResolver()
    const registry = createSessionsRegistry({ persist: false })
    const daemonMcpUrl = "http://127.0.0.1:4848/mcp"
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgentSession(),
      adapterSlug: "hermes",
      mcpServers: [
        {
          name: "agentproto",
          transport: "http",
          ref: `${daemonMcpUrl}?callerSessionId=${encodeURIComponent("placeholder")}`,
        },
      ],
    })
    // Stamp with the OLD session's own id, exactly like a real spawn would.
    prev.mcpServers = [
      { name: "agentproto", transport: "http", ref: `${daemonMcpUrl}?callerSessionId=${prev.id}` },
    ]

    const restarted = await restartAgentSession(registry, resolver, prev, {
      forceAgentResume: true,
      loadDefaultsConfig: NOOP_DEFAULTS,
      daemonMcpUrl,
    })

    const newId = restarted.desc.id
    const storedRef = restarted.desc.mcpServers?.[0]?.ref
    expect(storedRef).toContain(`callerSessionId=${newId}`)
    expect(storedRef).not.toContain(prev.id)

    // The live adapter process got the re-stamped entry too, not just the
    // stored descriptor — this is what every subsequent spawn/command_execute
    // the restarted session makes actually attributes through.
    const sentServers = calls[0]?.mcpServers as Array<{ ref: string }> | undefined
    expect(sentServers?.[0]?.ref).toContain(`callerSessionId=${newId}`)
    expect(sentServers?.[0]?.ref).not.toContain(prev.id)
  })

  it("strips the stale OLD stamp even when daemonMcpUrl is unknown (never replaced, but never left wrong)", async () => {
    const { resolver } = makeResolver()
    const registry = createSessionsRegistry({ persist: false })
    const daemonMcpUrl = "http://127.0.0.1:4848/mcp"
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgentSession(),
      adapterSlug: "hermes",
      mcpServers: [
        { name: "agentproto", transport: "http", ref: `${daemonMcpUrl}?callerSessionId=placeholder` },
      ],
    })
    prev.mcpServers = [
      { name: "agentproto", transport: "http", ref: `${daemonMcpUrl}?callerSessionId=${prev.id}` },
    ]

    // No `daemonMcpUrl` passed — the restart doesn't know the daemon's own
    // URL, so it can't re-stamp, but must never leave the OLD id attached.
    const restarted = await restartAgentSession(registry, resolver, prev, {
      forceAgentResume: true,
      loadDefaultsConfig: NOOP_DEFAULTS,
    })

    const storedRef = restarted.desc.mcpServers?.[0]?.ref
    expect(storedRef).not.toContain(prev.id)
    expect(storedRef).not.toContain("callerSessionId=")
  })

  it("leaves a caller's explicit third-party callerSessionId pin untouched (not our stamp to strip)", async () => {
    const { resolver } = makeResolver()
    const registry = createSessionsRegistry({ persist: false })
    const daemonMcpUrl = "http://127.0.0.1:4848/mcp"
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgentSession(),
      adapterSlug: "hermes",
      mcpServers: [
        {
          name: "external",
          transport: "http",
          ref: "https://example.com/mcp?callerSessionId=some-foreign-pin",
        },
      ],
    })

    const restarted = await restartAgentSession(registry, resolver, prev, {
      forceAgentResume: true,
      loadDefaultsConfig: NOOP_DEFAULTS,
      daemonMcpUrl,
    })

    expect(restarted.desc.mcpServers?.[0]?.ref).toBe(
      "https://example.com/mcp?callerSessionId=some-foreign-pin",
    )
  })
})

describe("restartAgentSession — the superseded OLD row is closed, never left running", () => {
  it("closes an ALIVE prior session with a deliberate 'restarted' reason, never 'crashed'/'error'", async () => {
    const { resolver } = makeResolver()
    const registry = createSessionsRegistry({ persist: false })
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgentSession(),
      adapterSlug: "hermes",
    })
    expect(registry.get(prev.id)?.status).toBe("running")

    const restarted = await restartAgentSession(registry, resolver, prev, {
      forceAgentResume: true,
      loadDefaultsConfig: NOOP_DEFAULTS,
    })

    const old = registry.get(prev.id)
    expect(old?.status).toBe("killed")
    expect(old?.endedReason).toBe("restarted")
    expect(old?.continuedTo).toBe(restarted.desc.id)
    // Never the unexpected-death pair `supervisor-notify.ts` /
    // `restart-scheduler.ts` key off — a restart was never a crash.
    expect(old?.status).not.toBe("error")
  })

  it("is a no-op on an already-dead prior session — its original endedReason survives untouched", async () => {
    const { resolver } = makeResolver()
    const registry = createSessionsRegistry({ persist: false })
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgentSession(),
      adapterSlug: "hermes",
    })
    registry.kill(prev.id, undefined, "operator-stopped")

    await restartAgentSession(registry, resolver, prev, {
      forceAgentResume: true,
      loadDefaultsConfig: NOOP_DEFAULTS,
    })

    expect(registry.get(prev.id)?.endedReason).toBe("operator-stopped")
  })
})
