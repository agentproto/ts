/**
 * `SessionsRegistryAgentHost` reports a session that died UNDER its workflow
 * step as `AgentSessionLostError` (`transport: true`) — the only failure an
 * agent step's transport `retry` re-spawns past. A deliberate end (operator
 * kill, cost cap, …), the run's own cancel, or a session this host already
 * released stays a plain `Error`. Regression for sess_bd64a550 (2026-10-08):
 * "ACP connection closed" mid-turn, row ended `killed` with no reason.
 */

import { describe, it, expect } from "vitest"
import { AgentSessionLostError, isAgentTransportFailure } from "@agentproto/workflow-runtime"
import { createSessionEventBus } from "../session-event-bus.js"
import { SessionsRegistryAgentHost } from "../sessions-registry-agent-host.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { SessionEndReason } from "../session-end-reason.js"

const SID = "sess_step"

function makeRegistry(sendPrompt: () => Promise<void> = () => new Promise<void>(() => {})) {
  const desc: SessionDescriptor = {
    id: SID,
    kind: "agent-cli",
    workspaceSlug: "test",
    command: "mock",
    pid: null,
    status: "running",
    startedAt: new Date().toISOString(),
  }
  const registry = {
    get: (id: string) => (id === SID ? desc : undefined),
    sendPrompt,
  } as unknown as SessionsRegistry
  return { registry, desc }
}

const resolveAgentAdapter: AgentAdapterResolver = async () => {
  throw new Error("not used by this test")
}

function makeHost(registry: SessionsRegistry, opts: { signal?: AbortSignal; spawnedByHost?: boolean } = {}) {
  const sessionEvents = createSessionEventBus()
  const host = new SessionsRegistryAgentHost(registry, sessionEvents, resolveAgentAdapter, {
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  // Stand in for a real spawn, which registers the session as one this host
  // owns (and has not released yet).
  if (opts.spawnedByHost !== false) (host as unknown as { unreleased: Set<string> }).unreleased.add(SID)
  return { host, sessionEvents }
}

async function killMidTurn(reason?: SessionEndReason, opts: { signal?: AbortSignal; spawnedByHost?: boolean } = {}) {
  const { registry } = makeRegistry()
  const { host, sessionEvents } = makeHost(registry, opts)
  const wait = host.sendPromptAndWait(SID, "fix the facts")
  await new Promise((r) => setImmediate(r))
  sessionEvents.emit({
    type: "session:exited",
    sessionId: SID,
    status: "killed",
    ...(reason ? { reason } : {}),
    ts: new Date().toISOString(),
  })
  return wait.then(
    () => undefined,
    (e: unknown) => e,
  )
}

describe("SessionsRegistryAgentHost — session lost under a workflow step", () => {
  it("an untagged mid-turn kill is AgentSessionLostError (transport) and keeps the old message", async () => {
    const err = await killMidTurn()
    expect(err).toBeInstanceOf(AgentSessionLostError)
    expect(isAgentTransportFailure(err)).toBe(true)
    expect((err as Error).message).toMatch(/ended with status 'killed'/)
  })

  it("a crash (endedReason: crashed) is a transport loss too", async () => {
    expect(await killMidTurn("crashed")).toBeInstanceOf(AgentSessionLostError)
  })

  it.each<SessionEndReason>(["operator-stopped", "cost-cap-exceeded", "provider-limit", "context-hard-stop"])(
    "a deliberate end (%s) stays a plain failure",
    async (reason) => {
      const err = await killMidTurn(reason)
      expect(err).toBeInstanceOf(Error)
      expect(isAgentTransportFailure(err)).toBe(false)
      expect((err as Error).message).toContain(`(${reason})`)
    },
  )

  it("the run's own cancel killing the session is not a transport loss", async () => {
    const ac = new AbortController()
    ac.abort()
    expect(isAgentTransportFailure(await killMidTurn(undefined, { signal: ac.signal }))).toBe(false)
  })

  it("a session this host does not own (or already released) is not a transport loss", async () => {
    expect(isAgentTransportFailure(await killMidTurn(undefined, { spawnedByHost: false }))).toBe(false)
  })

  it("sendPrompt rejecting 'ACP connection closed' is a transport loss, cause preserved", async () => {
    const cause = new Error("ACP connection closed")
    const { registry } = makeRegistry(() => Promise.reject(cause))
    const { host } = makeHost(registry)
    const err = await host.sendPromptAndWait(SID, "go").then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(AgentSessionLostError)
    expect((err as AgentSessionLostError).cause).toBe(cause)
    expect((err as Error).message).toContain("ACP connection closed")
  })

  it("any other sendPrompt rejection on a live session propagates unchanged", async () => {
    const original = new Error("prompt queue is full")
    const { registry } = makeRegistry(() => Promise.reject(original))
    const { host } = makeHost(registry)
    const err = await host.sendPromptAndWait(SID, "go").then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBe(original)
  })
})
