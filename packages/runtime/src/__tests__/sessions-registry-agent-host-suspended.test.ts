/**
 * A workflow agent step whose session is parked on an approval must FAIL the
 * step. Seen on a real run (scout-run, mastra-agent in plan mode): the agent
 * called `submit_plan`, the turn ended "normally" with a "run suspended,
 * waiting for approval" note, `onAwaitingInput` returned because
 * `awaitingInput` was false, and the whole workflow was reported `done`
 * having executed nothing.
 */

import { describe, it, expect } from "vitest"
import { createSessionEventBus } from "../session-event-bus.js"
import { SessionsRegistryAgentHost } from "../sessions-registry-agent-host.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

const resolveAgentAdapter: AgentAdapterResolver = async () => {
  throw new Error("not used by this test")
}

function hostFor(desc: Partial<SessionDescriptor>): SessionsRegistryAgentHost {
  const full = {
    id: "sess_x",
    kind: "agent-cli",
    workspaceSlug: "test",
    command: "mock",
    pid: null,
    status: "running",
    startedAt: new Date().toISOString(),
    ...desc,
  } as SessionDescriptor
  const registry = { get: (id: string) => (id === "sess_x" ? full : undefined) } as unknown as SessionsRegistry
  return new SessionsRegistryAgentHost(registry, createSessionEventBus(), resolveAgentAdapter)
}

describe("SessionsRegistryAgentHost.onAwaitingInput, parked on an approval", () => {
  it("fails the step when the session has a pending permission request", async () => {
    const host = hostFor({ awaitingPermission: true })
    await expect(host.onAwaitingInput("sess_x", { awaiting: "fail" })).rejects.toThrow(/permission request/)
  })

  it("fails the step when the mastra-agent turn ended with its suspended note", async () => {
    const host = hostFor({})
    host.readFinalMessage = async () => "[mastra-agent] run suspended — waiting for approval before continuing."
    await expect(host.onAwaitingInput("sess_x", { awaiting: "fail" })).rejects.toThrow(/suspended/)
  })

  it("lets a normally finished session through", async () => {
    const host = hostFor({})
    host.readFinalMessage = async () => "done: 3 new offers"
    await expect(host.onAwaitingInput("sess_x", { awaiting: "fail" })).resolves.toBeUndefined()
  })
})
