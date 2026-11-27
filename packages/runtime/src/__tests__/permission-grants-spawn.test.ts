/**
 * `defaults.permissionGrants` reaches the adapter: a session spawned (or
 * restarted) with the host-guard escalation label is started with the
 * `agentproto host stop-process` allow rule; any other label is not.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { restartAgentSession } from "../session-restart-core.js"
import { cdContractLine } from "../agents-md.js"
import type { AgentAdapterResolver } from "../http-server.js"
import { HOST_STOP_PROCESS_RULE } from "../permission-grants.js"

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "permission-grants-spawn-"))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `acp_${Math.random().toString(36).slice(2)}`,
    async *send(): AsyncIterable<AgentStreamEvent> {
      yield { kind: "turn-end", reason: "completed" } as AgentStreamEvent
    },
    async cancel() {},
    async close() {},
  }
}

function recordingResolver(): { resolver: AgentAdapterResolver; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = []
  const resolver: AgentAdapterResolver = async () => ({
    async startSession(o: Record<string, unknown>) {
      calls.push(o)
      return fakeAgentSession()
    },
    commandPreview: "mock-adapter",
  })
  return { resolver, calls }
}

function spawnDeps(defaults: Record<string, unknown>, overrides: Partial<SpawnAgentSessionDeps> = {}): SpawnAgentSessionDeps {
  return {
    registry: createSessionsRegistry({ persist: false }),
    resolveAgentAdapter: recordingResolver().resolver,
    resolveAgentsMd: async () => ({ mode: "absent", contractLine: cdContractLine }),
    resolveWorkspaceRules: async () => ({}),
    loadDefaultsConfig: async () => defaults as never,
    ...overrides,
  }
}

async function spawnWith(defaults: Record<string, unknown>, adapter = "claude-code"): Promise<Record<string, unknown>> {
  const { resolver, calls } = recordingResolver()
  const res = await spawnAgentSession(spawnDeps(defaults, { resolveAgentAdapter: resolver }), { adapter, cwd: tmp })
  if (!res.ok) throw new Error(`spawn failed: ${res.message}`)
  expect(calls).toHaveLength(1)
  return calls[0]!
}

async function spawnLabelled(defaults: Record<string, unknown>, label: string | undefined, adapter = "claude-code") {
  const { resolver, calls } = recordingResolver()
  const res = await spawnAgentSession(spawnDeps(defaults, { resolveAgentAdapter: resolver }), {
    adapter,
    cwd: tmp,
    ...(label ? { label } : {}),
  })
  if (!res.ok) throw new Error(`spawn failed: ${res.message}`)
  return calls[0]!
}

describe("permission grants spawn wiring", () => {
  it("the escalation label gets the stop-process rule by default", async () => {
    expect((await spawnLabelled({}, "host-guard-escalation")).permissionAllow).toEqual([HOST_STOP_PROCESS_RULE])
  })

  it("another label, no label, or another adapter get nothing", async () => {
    expect(await spawnLabelled({}, "worker")).not.toHaveProperty("permissionAllow")
    expect(await spawnLabelled({}, undefined)).not.toHaveProperty("permissionAllow")
    expect(await spawnLabelled({}, "host-guard-escalation", "codex")).not.toHaveProperty("permissionAllow")
  })

  it("an operator's {} turns the grant off", async () => {
    expect(await spawnLabelled({ permissionGrants: {} }, "host-guard-escalation")).not.toHaveProperty("permissionAllow")
  })

  it("a restarted escalation session keeps its grant", async () => {
    const registry = createSessionsRegistry({ persist: false })
    try {
      const first = recordingResolver()
      const spawned = await spawnAgentSession(spawnDeps({}, { registry, resolveAgentAdapter: first.resolver }), {
        adapter: "claude-code",
        cwd: tmp,
        label: "host-guard-escalation",
      })
      if (!spawned.ok) throw new Error(`spawn failed: ${spawned.message}`)
      const second = recordingResolver()
      await restartAgentSession(registry, second.resolver, registry.get(spawned.descriptor.id)!, {
        forceAgentResume: true,
        loadDefaultsConfig: async () => ({}) as never,
      })
      expect(second.calls[0]!.permissionAllow).toEqual([HOST_STOP_PROCESS_RULE])
    } finally {
      registry.shutdown()
    }
  })
})
