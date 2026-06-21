import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createCompletionPolicySupervisor } from "../supervisor.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"

// ── Helpers ───────────────────────────────────────────────────────────

function makeMockRegistry(cwd: string): SessionsRegistry {
  const desc: SessionDescriptor = {
    id: "sess_test",
    kind: "agent-cli",
    workspaceSlug: "test",
    command: "mock",
    pid: null,
    status: "running",
    startedAt: new Date().toISOString(),
    cwd,
  }
  return {
    get: vi.fn((id: string) => (id === "sess_test" ? desc : undefined)),
    findByIdOrName: vi.fn((q: string) => (q === "sess_test" ? desc : undefined)),
    spawn: vi.fn(),
    register: vi.fn(),
    spawnAgent: vi.fn(),
    spawnPty: vi.fn(),
    sendPrompt: vi.fn(async () => {}),
    enqueuePrompt: vi.fn(),
    list: vi.fn(() => []),
    attach: vi.fn(() => null),
    attachPty: vi.fn(() => null),
    writeTerminalInput: vi.fn(() => false),
    readTerminalOutput: vi.fn(async () => ({ lines: [], nextCursor: 0 })),
    tailLines: vi.fn(async () => ({ lines: [], nextCursor: 0, skipped: 0 })),
    kill: vi.fn(),
    forget: vi.fn(),
    shutdown: vi.fn(),
  } as unknown as SessionsRegistry
}

async function makeWorkspace(commands: string[]): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "agentproto-supervisor-test-"))
  await mkdir(join(workspace, ".agentproto"), { recursive: true })
  await writeFile(
    join(workspace, ".agentproto", "allowed-commands.json"),
    JSON.stringify({ version: 1, commands }),
    "utf8",
  )
  return workspace
}

function wait(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms))
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("CompletionPolicySupervisor", () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await makeWorkspace(["true", "false"])
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it("attach() returns immediately with status=watching", () => {
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry: makeMockRegistry(workspace),
      sessionEvents: bus,
      workspace,
    })

    const state = supervisor.attach({ sessionId: "sess_test", then: "emit" })
    expect(state.status).toBe("watching")
    expect(state.policyId).toMatch(/^policy_/)
  })

  it("(a) session:turn-end triggers gate execution", async () => {
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry: makeMockRegistry(workspace),
      sessionEvents: bus,
      workspace,
    })

    const gatingReached = new Promise<void>(resolve => {
      const state = supervisor.attach({
        sessionId: "sess_test",
        gate: { command: "true" },
        then: "emit",
      })
      const poll = setInterval(() => {
        const s = supervisor.getStatus(state.policyId)
        if (s && s.status !== "watching") {
          clearInterval(poll)
          resolve()
        }
      }, 5)
    })

    // Fire turn-end — this should trigger gate execution
    bus.emit({ type: "session:turn-end", sessionId: "sess_test", awaitingInput: false, ts: new Date().toISOString() })

    // Gate should move out of "watching" (to gating/acting/done) within 500ms
    await expect(gatingReached).resolves.toBeUndefined()
  })

  it("(b) gate exit 0 → policy:passed emitted on bus", async () => {
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry: makeMockRegistry(workspace),
      sessionEvents: bus,
      workspace,
    })

    const passedEvent = new Promise<{ policyId: string }>(resolve => {
      bus.on("policy:passed", ev => resolve({ policyId: ev.policyId }))
    })

    const state = supervisor.attach({
      sessionId: "sess_test",
      gate: { command: "true" },
      then: "emit",
    })

    bus.emit({ type: "session:turn-end", sessionId: "sess_test", awaitingInput: false, ts: new Date().toISOString() })

    const ev = await passedEvent
    expect(ev.policyId).toBe(state.policyId)

    // State should be "done" after the event
    await wait(20)
    expect(supervisor.getStatus(state.policyId)?.status).toBe("done")
  })

  it("(c) gate exit != 0 → policy:failed emitted on bus", async () => {
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry: makeMockRegistry(workspace),
      sessionEvents: bus,
      workspace,
    })

    const failedEvent = new Promise<{ policyId: string; exitCode?: number }>(resolve => {
      bus.on("policy:failed", ev => resolve({ policyId: ev.policyId, exitCode: ev.exitCode }))
    })

    const state = supervisor.attach({
      sessionId: "sess_test",
      gate: { command: "false" },
      then: "emit",
    })

    bus.emit({ type: "session:turn-end", sessionId: "sess_test", awaitingInput: false, ts: new Date().toISOString() })

    const ev = await failedEvent
    expect(ev.policyId).toBe(state.policyId)
    expect(ev.exitCode).toBe(1)

    await wait(20)
    expect(supervisor.getStatus(state.policyId)?.status).toBe("blocked")
  })

  it("no gate → passes immediately on turn-end", async () => {
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry: makeMockRegistry(workspace),
      sessionEvents: bus,
      workspace,
    })

    const passedEvent = new Promise<void>(resolve => {
      bus.on("policy:passed", () => resolve())
    })

    supervisor.attach({ sessionId: "sess_test", then: "emit" })
    bus.emit({ type: "session:turn-end", sessionId: "sess_test", awaitingInput: false, ts: new Date().toISOString() })

    await expect(passedEvent).resolves.toBeUndefined()
  })

  it("session:exited while watching → status becomes cancelled", async () => {
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry: makeMockRegistry(workspace),
      sessionEvents: bus,
      workspace,
    })

    const state = supervisor.attach({ sessionId: "sess_test", then: "emit" })

    bus.emit({ type: "session:exited", sessionId: "sess_test", status: "exited", ts: new Date().toISOString() })
    await wait(10)

    expect(supervisor.getStatus(state.policyId)?.status).toBe("cancelled")
  })

  it("cancel() stops a watching policy", async () => {
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry: makeMockRegistry(workspace),
      sessionEvents: bus,
      workspace,
    })

    const state = supervisor.attach({
      sessionId: "sess_test",
      gate: { command: "true" },
      then: "emit",
    })

    supervisor.cancel(state.policyId)
    expect(supervisor.getStatus(state.policyId)?.status).toBe("cancelled")

    // Turn-end after cancel should not trigger gate
    const passed = vi.fn()
    bus.on("policy:passed", passed)
    bus.emit({ type: "session:turn-end", sessionId: "sess_test", awaitingInput: false, ts: new Date().toISOString() })
    await wait(100)
    expect(passed).not.toHaveBeenCalled()
  })

  it("list() returns all attached policies", () => {
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry: makeMockRegistry(workspace),
      sessionEvents: bus,
      workspace,
    })

    supervisor.attach({ sessionId: "sess_test", then: "emit" })
    supervisor.attach({ sessionId: "sess_test", then: "emit" })

    expect(supervisor.list()).toHaveLength(2)
  })

  it("gate command not in allowlist → policy:failed (blocked)", async () => {
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry: makeMockRegistry(workspace),
      sessionEvents: bus,
      workspace,
    })

    const failedEvent = new Promise<void>(resolve => {
      bus.on("policy:failed", () => resolve())
    })

    const state = supervisor.attach({
      sessionId: "sess_test",
      gate: { command: "not-allowed-cmd" },
      then: "emit",
    })

    bus.emit({ type: "session:turn-end", sessionId: "sess_test", awaitingInput: false, ts: new Date().toISOString() })
    await failedEvent

    expect(supervisor.getStatus(state.policyId)?.status).toBe("blocked")
    expect(supervisor.getStatus(state.policyId)?.error).toMatch(/not in allowlist/)
  })
})
