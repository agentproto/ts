import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createCompletionPolicySupervisor } from "../supervisor.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"
import type { SessionEventBus } from "../session-event-bus.js"

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

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("waitFor timed out")
    await wait(intervalMs)
  }
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

  it("WP1 gate command not in allowlist → policy:failed (blocked)", async () => {
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

// ── WP2: bounded nudge + escalate ────────────────────────────────────

/**
 * Creates a shell script that exits 1 on the first invocation (removing a
 * flag file) and exits 0 on all subsequent ones. Allowlist must include
 * "fail-once.sh". Returns the absolute path to the script.
 */
async function addFailOnceScript(ws: string): Promise<string> {
  const dir = join(ws, ".agentproto")
  const flagPath = join(dir, "fail-once.flag")
  const scriptPath = join(dir, "fail-once.sh")
  await writeFile(flagPath, "1", "utf8")
  const script = [
    "#!/bin/sh",
    `if [ -f "${flagPath}" ]; then`,
    `  rm "${flagPath}"`,
    "  exit 1",
    "fi",
    "exit 0",
    "",
  ].join("\n")
  await writeFile(scriptPath, script, { mode: 0o755 })
  return scriptPath
}

function fireTurnEnd(bus: SessionEventBus, sessionId = "sess_test"): void {
  bus.emit({
    type: "session:turn-end",
    sessionId,
    awaitingInput: false,
    ts: new Date().toISOString(),
  })
}

describe("WP2 — bounded nudge + escalate", () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await makeWorkspace(["true", "false", "fail-once.sh"])
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it("(a) gate failure sends nudge to session and returns to watching", async () => {
    const registry = makeMockRegistry(workspace)
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry,
      sessionEvents: bus,
      workspace,
    })

    const state = supervisor.attach({
      sessionId: "sess_test",
      gate: { command: "false" },
      then: "emit",
      onFail: { nudge: "fix it (exit {code})", maxRetries: 2 },
    })

    fireTurnEnd(bus)
    await waitFor(() => state.retries === 1)

    expect(registry.sendPrompt).toHaveBeenCalledWith("sess_test", "fix it (exit 1)")
    expect(state.status).toBe("watching")
    expect(state.retries).toBe(1)
  })

  it("(b) after nudge, next turn-end re-triggers the gate", async () => {
    const registry = makeMockRegistry(workspace)
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry,
      sessionEvents: bus,
      workspace,
    })

    supervisor.attach({
      sessionId: "sess_test",
      gate: { command: "false" },
      then: "emit",
      onFail: { nudge: "retry", maxRetries: 3 },
    })

    // First failure → nudge → watching (retries=1)
    fireTurnEnd(bus)
    await waitFor(() => vi.mocked(registry.sendPrompt).mock.calls.length >= 1)
    expect(registry.sendPrompt).toHaveBeenCalledTimes(1)

    // Second turn-end → gate runs again → fails → nudge (retries=2)
    fireTurnEnd(bus)
    await waitFor(() => vi.mocked(registry.sendPrompt).mock.calls.length >= 2)

    expect(registry.sendPrompt).toHaveBeenCalledTimes(2)
  })

  it("(c) gate passes at retry → policy:passed (done)", async () => {
    const scriptPath = await addFailOnceScript(workspace)
    const registry = makeMockRegistry(workspace)
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry,
      sessionEvents: bus,
      workspace,
    })

    const passedEvent = new Promise<{ policyId: string }>(resolve => {
      bus.on("policy:passed", ev => resolve({ policyId: ev.policyId }))
    })

    const state = supervisor.attach({
      sessionId: "sess_test",
      gate: { command: scriptPath },
      then: "emit",
      onFail: { nudge: "try again", maxRetries: 2 },
    })

    // First turn-end → gate fails (flag present) → nudge → watching
    fireTurnEnd(bus)
    await waitFor(() => state.retries === 1)
    expect(state.retries).toBe(1)
    expect(state.status).toBe("watching")

    // Second turn-end → gate passes (flag removed) → policy:passed
    fireTurnEnd(bus)

    const ev = await passedEvent
    expect(ev.policyId).toBe(state.policyId)
    await wait(20)
    expect(state.status).toBe("done")
  })

  it("(d) maxRetries exhausted → blocked + policy:failed emitted", async () => {
    const registry = makeMockRegistry(workspace)
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry,
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
      onFail: { nudge: "try again (exit {code})", maxRetries: 1 },
    })

    // First failure → nudge sent (retries=1, now at maxRetries)
    fireTurnEnd(bus)
    await waitFor(() => state.retries === 1)
    expect(state.retries).toBe(1)
    expect(state.status).toBe("watching")

    // Second failure → retries exhausted → blocked + policy:failed
    fireTurnEnd(bus)

    const ev = await failedEvent
    expect(ev.exitCode).toBe(1)
    await wait(20)
    expect(state.status).toBe("blocked")
    // sendPrompt called exactly once (only the first failure nudgeable)
    expect(registry.sendPrompt).toHaveBeenCalledTimes(1)
  })
})

// ── WP3: persistence ─────────────────────────────────────────────────

/**
 * Build a minimal registry where sess_test is "running" by default,
 * but can be swapped to a different status for the "session absent" case.
 */
function makeRegistryWithStatus(
  cwd: string,
  status: SessionDescriptor["status"] = "running",
): SessionsRegistry {
  const desc: SessionDescriptor = {
    id: "sess_test",
    kind: "agent-cli",
    workspaceSlug: "test",
    command: "mock",
    pid: null,
    status,
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

describe("WP3 — persistence", () => {
  let workspace: string
  let persistPath: string

  beforeEach(async () => {
    workspace = await makeWorkspace(["true", "false"])
    const tmp = await mkdtemp(join(tmpdir(), "agentproto-sup-persist-"))
    persistPath = join(tmp, "policies.json")
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
    await rm(join(persistPath, ".."), { recursive: true, force: true })
  })

  it("(a) policy is written to disk after attach + shutdown", async () => {
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry: makeRegistryWithStatus(workspace),
      sessionEvents: bus,
      workspace,
      persistPath,
    })

    const state = supervisor.attach({ sessionId: "sess_test", then: "emit" })
    supervisor.shutdown()

    const raw = await readFile(persistPath, "utf8")
    const snap = JSON.parse(raw)
    expect(snap.policies).toHaveLength(1)
    expect(snap.policies[0].state.policyId).toBe(state.policyId)
    expect(snap.policies[0].state.status).toBe("watching")
    expect(snap.policies[0].input.sessionId).toBe("sess_test")
  })

  it("(b) reload restores policy state from disk", async () => {
    const bus1 = createSessionEventBus()
    const sup1 = createCompletionPolicySupervisor({
      registry: makeRegistryWithStatus(workspace),
      sessionEvents: bus1,
      workspace,
      persistPath,
    })
    const state = sup1.attach({ sessionId: "sess_test", then: "emit" })
    sup1.shutdown()

    // Simulate restart: new supervisor loads the file
    const bus2 = createSessionEventBus()
    const sup2 = createCompletionPolicySupervisor({
      registry: makeRegistryWithStatus(workspace),
      sessionEvents: bus2,
      workspace,
      persistPath,
    })

    const restored = sup2.getStatus(state.policyId)
    expect(restored).toBeDefined()
    expect(restored?.policyId).toBe(state.policyId)
    expect(restored?.status).toBe("watching")
  })

  it("(c) re-arm: turn-end after reload triggers gate", async () => {
    const bus1 = createSessionEventBus()
    const sup1 = createCompletionPolicySupervisor({
      registry: makeRegistryWithStatus(workspace),
      sessionEvents: bus1,
      workspace,
      persistPath,
    })
    const state = sup1.attach({
      sessionId: "sess_test",
      gate: { command: "true" },
      then: "emit",
    })
    sup1.shutdown()

    // Restart
    const bus2 = createSessionEventBus()
    const sup2 = createCompletionPolicySupervisor({
      registry: makeRegistryWithStatus(workspace),
      sessionEvents: bus2,
      workspace,
      persistPath,
    })

    const passedEvent = new Promise<string>(resolve => {
      bus2.on("policy:passed", ev => resolve(ev.policyId))
    })

    // Fire turn-end on the new bus → re-armed policy should run the gate
    bus2.emit({
      type: "session:turn-end",
      sessionId: "sess_test",
      awaitingInput: false,
      ts: new Date().toISOString(),
    })

    const policyId = await passedEvent
    expect(policyId).toBe(state.policyId)

    await wait(20)
    expect(sup2.getStatus(state.policyId)?.status).toBe("done")
  })

  it("(d) session absent at reload → policy cancelled, no crash", async () => {
    const bus1 = createSessionEventBus()
    const sup1 = createCompletionPolicySupervisor({
      registry: makeRegistryWithStatus(workspace, "running"),
      sessionEvents: bus1,
      workspace,
      persistPath,
    })
    const state = sup1.attach({ sessionId: "sess_test", then: "emit" })
    sup1.shutdown()

    // Restart with a registry that reports the session as "killed"
    const bus2 = createSessionEventBus()
    const sup2 = createCompletionPolicySupervisor({
      registry: makeRegistryWithStatus(workspace, "killed"),
      sessionEvents: bus2,
      workspace,
      persistPath,
    })

    const restored = sup2.getStatus(state.policyId)
    expect(restored?.status).toBe("cancelled")
    expect(restored?.error).toMatch(/session absent/)

    // No gate should run even if a turn-end fires
    const passed = vi.fn()
    bus2.on("policy:passed", passed)
    bus2.emit({
      type: "session:turn-end",
      sessionId: "sess_test",
      awaitingInput: false,
      ts: new Date().toISOString(),
    })
    await wait(100)
    expect(passed).not.toHaveBeenCalled()
  })
})
