import { describe, expect, it, vi } from "vitest"

import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
} from "../sessions.js"
import { cdContractLine } from "../agents-md.js"
import type { AgentAdapterResolver } from "../http-server.js"

/**
 * `notifyParentOnCrash` default: an executor with a declared or attached
 * parent opts in, so a supervisor hears about a silent death; an explicit
 * `false` still opts out, and a session without a parent or an executor role
 * keeps the old off default.
 */

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: "acp_test",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function makeDeps(): SpawnAgentSessionDeps {
  const registry = createSessionsRegistry({ persist: false })
  const startSession = vi.fn(async () => fakeAgentSession())
  const resolveAgentAdapter: AgentAdapterResolver = async () => ({
    startSession: startSession as never,
    commandPreview: "mock-adapter",
  })
  return {
    registry,
    resolveAgentAdapter,
    resolveAgentsMd: async () => ({ mode: "absent", contractLine: cdContractLine }),
    resolveWorkspaceRules: async () => ({}),
    resolveSpawnAttach: async () => "on-request",
  }
}

async function spawn(extra: Record<string, unknown>) {
  const deps = makeDeps()
  const result = await spawnAgentSession(deps, { adapter: "mock", cwd: "/tmp", dedupe: false, ...extra })
  if (!result.ok) throw new Error(`spawn failed: ${result.message}`)
  return deps.registry.get(result.descriptor.id)
}

describe("agent_start notifyParentOnCrash default", () => {
  it("defaults to true for an executor with a declared parent", async () => {
    const row = await spawn({ role: "executor", parentSessionId: "ses_parent" })
    expect(row?.notifyParentOnCrash).toBe(true)
  })

  it("keeps an explicit false", async () => {
    const row = await spawn({ role: "executor", parentSessionId: "ses_parent", notifyParentOnCrash: false })
    expect(row?.notifyParentOnCrash).toBeUndefined()
  })

  it("keeps an explicit true for a supervisor", async () => {
    const row = await spawn({ role: "supervisor", parentSessionId: "ses_parent", notifyParentOnCrash: true })
    expect(row?.notifyParentOnCrash).toBe(true)
  })

  it("stays off for an executor without a parent", async () => {
    const row = await spawn({ role: "executor" })
    expect(row?.notifyParentOnCrash).toBeUndefined()
  })

  it("stays off for a supervisor with a parent", async () => {
    const row = await spawn({ role: "supervisor", parentSessionId: "ses_parent" })
    expect(row?.notifyParentOnCrash).toBeUndefined()
  })
})
