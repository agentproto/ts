import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createCompletionPolicySupervisor, runShellGate } from "../supervisor.js"
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

// ── WP4: fan-in (all-of group) ───────────────────────────────────────

/**
 * Registry that knows about an arbitrary set of session ids, all "running"
 * by default. A subset can be reported with a different status (e.g. "exited")
 * to exercise the absent-member / reload paths.
 */
function makeMultiRegistry(
  cwd: string,
  ids: string[],
  overrides: Record<string, SessionDescriptor["status"]> = {},
): SessionsRegistry {
  const descs = new Map<string, SessionDescriptor>()
  for (const id of ids) {
    descs.set(id, {
      id,
      kind: "agent-cli",
      workspaceSlug: "test",
      command: "mock",
      pid: null,
      status: overrides[id] ?? "running",
      startedAt: new Date().toISOString(),
      cwd,
    })
  }
  return {
    get: vi.fn((id: string) => descs.get(id)),
    findByIdOrName: vi.fn((q: string) => descs.get(q)),
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

function fireExit(bus: SessionEventBus, sessionId: string): void {
  bus.emit({
    type: "session:exited",
    sessionId,
    status: "exited",
    ts: new Date().toISOString(),
  })
}

describe("WP4 — fan-in (all-turn-end group)", () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await makeWorkspace(["true", "false"])
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it("(a) gate runs ONLY after all 3 group members fire turn-end", async () => {
    const ids = ["s1", "s2", "s3"]
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry: makeMultiRegistry(workspace, ids),
      sessionEvents: bus,
      workspace,
    })

    let passedAt: number | null = null
    bus.on("policy:passed", () => {
      passedAt = Date.now()
    })

    const state = supervisor.attach({
      sessionIds: ids,
      gate: { command: "true" },
      then: "emit",
    })
    expect(state.sessionIds).toEqual(ids)
    expect(state.pending).toEqual(ids)

    // After 1st turn-end: still watching, pending shrinks, no gate yet.
    fireTurnEnd(bus, "s1")
    await wait(30)
    expect(state.status).toBe("watching")
    expect(state.pending).toEqual(["s2", "s3"])
    expect(passedAt).toBeNull()

    // After 2nd turn-end: still watching, still no gate.
    fireTurnEnd(bus, "s2")
    await wait(30)
    expect(state.status).toBe("watching")
    expect(state.pending).toEqual(["s3"])
    expect(passedAt).toBeNull()

    // 3rd turn-end empties the set → gate runs → policy:passed → done.
    fireTurnEnd(bus, "s3")
    await waitFor(() => state.status === "done")
    expect(passedAt).not.toBeNull()
  })

  it("(b) repeated turn-end of one member does not trigger prematurely", async () => {
    const ids = ["s1", "s2", "s3"]
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry: makeMultiRegistry(workspace, ids),
      sessionEvents: bus,
      workspace,
    })

    const passed = vi.fn()
    bus.on("policy:passed", passed)

    const state = supervisor.attach({
      sessionIds: ids,
      gate: { command: "true" },
      then: "emit",
    })

    // s1 fires turn-end three times — must only count once (idempotent set).
    fireTurnEnd(bus, "s1")
    fireTurnEnd(bus, "s1")
    fireTurnEnd(bus, "s1")
    await wait(50)
    expect(state.status).toBe("watching")
    expect(state.pending).toEqual(["s2", "s3"])
    expect(passed).not.toHaveBeenCalled()

    // The remaining two members still need to finish.
    fireTurnEnd(bus, "s2")
    await wait(30)
    expect(passed).not.toHaveBeenCalled()
    expect(state.pending).toEqual(["s3"])

    fireTurnEnd(bus, "s3")
    await waitFor(() => state.status === "done")
    expect(passed).toHaveBeenCalledTimes(1)
  })

  it("(c) a member that exits counts as done (completes the fan-in)", async () => {
    const ids = ["s1", "s2", "s3"]
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry: makeMultiRegistry(workspace, ids),
      sessionEvents: bus,
      workspace,
    })

    const passed = vi.fn()
    bus.on("policy:passed", passed)

    const state = supervisor.attach({
      sessionIds: ids,
      gate: { command: "true" },
      then: "emit",
    })

    fireTurnEnd(bus, "s1")
    // s2 exits instead of finishing a turn — still removes it from pending.
    fireExit(bus, "s2")
    await wait(30)
    expect(state.status).toBe("watching")
    expect(state.pending).toEqual(["s3"])
    expect(passed).not.toHaveBeenCalled()

    // Last member turn-ends → gate runs once.
    fireTurnEnd(bus, "s3")
    await waitFor(() => state.status === "done")
    expect(passed).toHaveBeenCalledTimes(1)
  })

  it("(c2) all members exiting also completes the fan-in (gate runs once)", async () => {
    const ids = ["s1", "s2"]
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry: makeMultiRegistry(workspace, ids),
      sessionEvents: bus,
      workspace,
    })

    const state = supervisor.attach({
      sessionIds: ids,
      gate: { command: "true" },
      then: "emit",
    })

    fireExit(bus, "s1")
    await wait(20)
    expect(state.status).toBe("watching")
    fireExit(bus, "s2")
    await waitFor(() => state.status === "done")
  })

  it("(d) back-compat: single sessionId still gates after one turn-end", async () => {
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry: makeMockRegistry(workspace),
      sessionEvents: bus,
      workspace,
    })

    const passed = vi.fn()
    bus.on("policy:passed", passed)

    const state = supervisor.attach({
      sessionId: "sess_test",
      gate: { command: "true" },
      then: "emit",
    })
    // Normalised into a group of one.
    expect(state.sessionIds).toEqual(["sess_test"])
    expect(state.pending).toEqual(["sess_test"])

    fireTurnEnd(bus, "sess_test")
    await waitFor(() => state.status === "done")
    expect(passed).toHaveBeenCalledTimes(1)
  })

  it("(d2) back-compat: single sessionId exit still cancels (not gates)", async () => {
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry: makeMockRegistry(workspace),
      sessionEvents: bus,
      workspace,
    })

    const passed = vi.fn()
    bus.on("policy:passed", passed)

    const state = supervisor.attach({
      sessionId: "sess_test",
      gate: { command: "true" },
      then: "emit",
    })
    fireExit(bus, "sess_test")
    await wait(30)
    expect(state.status).toBe("cancelled")
    expect(passed).not.toHaveBeenCalled()
  })

  it("(e) fan-in group persists + re-arms only still-pending members", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agentproto-sup-fanin-"))
    const persistPath = join(tmp, "policies.json")
    const ids = ["s1", "s2", "s3"]

    const bus1 = createSessionEventBus()
    const sup1 = createCompletionPolicySupervisor({
      registry: makeMultiRegistry(workspace, ids),
      sessionEvents: bus1,
      workspace,
      persistPath,
    })
    const state = sup1.attach({
      sessionIds: ids,
      gate: { command: "true" },
      then: "emit",
    })
    // s1 finishes before the crash; s2 + s3 still pending.
    fireTurnEnd(bus1, "s1")
    await waitFor(() => state.pending.length === 2)
    sup1.shutdown()

    // Restart — all three sessions still alive.
    const bus2 = createSessionEventBus()
    const sup2 = createCompletionPolicySupervisor({
      registry: makeMultiRegistry(workspace, ids),
      sessionEvents: bus2,
      workspace,
      persistPath,
    })
    const restored = sup2.getStatus(state.policyId)
    expect(restored?.status).toBe("watching")
    expect(restored?.pending).toEqual(["s2", "s3"])

    const passed = vi.fn()
    bus2.on("policy:passed", passed)

    // s1 already done before the crash — its re-fire must not complete the group.
    fireTurnEnd(bus2, "s1")
    await wait(30)
    expect(passed).not.toHaveBeenCalled()

    fireTurnEnd(bus2, "s2")
    fireTurnEnd(bus2, "s3")
    await waitFor(() => sup2.getStatus(state.policyId)?.status === "done")
    expect(passed).toHaveBeenCalledTimes(1)

    await rm(tmp, { recursive: true, force: true })
  })
})

// ── WP5: commit action + requireHumanAck gate ────────────────────────

import type { RunCommandInput, ExecuteResult } from "../command-tools.js"

const FAKE_SHA = "deadbeefcafe1234567890abcdef0987654321aa"

/**
 * Mock command runner standing in for git (and the gate command). Records
 * every (command, args) so tests can assert the EXACT argv — proving we never
 * pass -A / push / --force and that the message goes through argv, not a shell.
 * `git rev-parse` returns a fixed sha; everything else exits 0.
 */
function makeGitMock(opts: { commitExitCode?: number; commitOut?: string } = {}) {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = []
  const exec = vi.fn(async (input: RunCommandInput): Promise<ExecuteResult> => {
    calls.push({ command: input.command, args: input.args, cwd: input.cwd })
    const base = (s: string) => s.split("/").pop() ?? s
    if (base(input.command) === "git") {
      if (input.args[0] === "rev-parse") {
        return mkResult({ stdout: FAKE_SHA + "\n" })
      }
      if (input.args[0] === "commit") {
        return mkResult({
          exitCode: opts.commitExitCode ?? 0,
          stdout: opts.commitOut ?? "[feat abc1234] msg\n",
        })
      }
      // git add
      return mkResult({})
    }
    // gate command (e.g. "true") → pass
    return mkResult({})
  })
  return { exec, calls }
}

function mkResult(p: Partial<ExecuteResult>): ExecuteResult {
  return {
    exitCode: p.exitCode ?? 0,
    signal: null,
    stdout: p.stdout ?? "",
    stderr: p.stderr ?? "",
    durationMs: 1,
  }
}

/** Assert no git invocation ever used a forbidden flag/subcommand. */
function assertNoForbiddenArgv(
  calls: Array<{ command: string; args: string[] }>,
): void {
  const flat = calls.flatMap(c => [c.command, ...c.args])
  for (const tok of flat) {
    expect(tok).not.toBe("-A")
    expect(tok).not.toBe("--all")
    expect(tok).not.toBe("-f")
    expect(tok).not.toBe("--force")
    expect(tok).not.toBe("push")
  }
}

describe("WP5 — commit action + requireHumanAck gate", () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await makeWorkspace(["true", "false", "git"])
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it("(a) green gate + requireHumanAck → policy:commit-ready, NO commit before ack", async () => {
    const { exec, calls } = makeGitMock()
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry: makeMockRegistry(workspace),
      sessionEvents: bus,
      workspace,
      runCommand: exec,
    })

    const readyEvent = new Promise<{ paths: string[]; message: string }>(resolve => {
      bus.on("policy:commit-ready", ev => resolve({ paths: ev.paths, message: ev.message }))
    })
    const committed = vi.fn()
    bus.on("policy:committed", committed)

    const state = supervisor.attach({
      sessionId: "sess_test",
      gate: { command: "true" },
      then: "commit",
      commit: { paths: ["src/a.ts", "src/b.ts"], message: "feat: x" },
    })

    fireTurnEnd(bus)

    const ev = await readyEvent
    expect(ev.paths).toEqual(["src/a.ts", "src/b.ts"])
    expect(ev.message).toBe("feat: x")

    await wait(30)
    // Parked awaiting ack — NO git add/commit happened.
    expect(supervisor.getStatus(state.policyId)?.status).toBe("awaiting-ack")
    expect(committed).not.toHaveBeenCalled()
    expect(calls.some(c => c.command === "git")).toBe(false)
  })

  it("(b) ack(approve:true) → git add <paths> + git commit (argv, no -A/push) → policy:committed", async () => {
    const { exec, calls } = makeGitMock()
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry: makeMockRegistry(workspace),
      sessionEvents: bus,
      workspace,
      runCommand: exec,
    })

    const committedEvent = new Promise<{ sha: string }>(resolve => {
      bus.on("policy:committed", ev => resolve({ sha: ev.sha }))
    })

    const state = supervisor.attach({
      sessionId: "sess_test",
      gate: { command: "true" },
      then: "commit",
      commit: { paths: ["src/a.ts"], message: "feat: commit me" },
    })

    fireTurnEnd(bus)
    await waitFor(() => supervisor.getStatus(state.policyId)?.status === "awaiting-ack")

    const acked = await supervisor.ack(state.policyId, true)
    expect(acked?.status).toBe("done")

    const ev = await committedEvent
    expect(ev.sha).toBe(FAKE_SHA)
    expect(supervisor.getStatus(state.policyId)?.commitSha).toBe(FAKE_SHA)

    // Exact argv: git add -- src/a.ts ; git commit -m "feat: commit me"
    const addCall = calls.find(c => c.command === "git" && c.args[0] === "add")
    expect(addCall?.args).toEqual(["add", "--", "src/a.ts"])
    const commitCall = calls.find(c => c.command === "git" && c.args[0] === "commit")
    expect(commitCall?.args).toEqual(["commit", "-m", "feat: commit me"])
    assertNoForbiddenArgv(calls)
  })

  it("(c) ack(approve:false) → cancelled, NO commit", async () => {
    const { exec, calls } = makeGitMock()
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry: makeMockRegistry(workspace),
      sessionEvents: bus,
      workspace,
      runCommand: exec,
    })

    const committed = vi.fn()
    bus.on("policy:committed", committed)

    const state = supervisor.attach({
      sessionId: "sess_test",
      gate: { command: "true" },
      then: "commit",
      commit: { paths: ["src/a.ts"], message: "feat: nope" },
    })

    fireTurnEnd(bus)
    await waitFor(() => supervisor.getStatus(state.policyId)?.status === "awaiting-ack")

    const acked = await supervisor.ack(state.policyId, false)
    expect(acked?.status).toBe("cancelled")
    await wait(20)
    expect(committed).not.toHaveBeenCalled()
    expect(calls.some(c => c.command === "git")).toBe(false)
  })

  it("(d) requireHumanAck:false → commit directly at green gate", async () => {
    const { exec, calls } = makeGitMock()
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry: makeMockRegistry(workspace),
      sessionEvents: bus,
      workspace,
      runCommand: exec,
    })

    const ready = vi.fn()
    bus.on("policy:commit-ready", ready)
    const committedEvent = new Promise<{ sha: string }>(resolve => {
      bus.on("policy:committed", ev => resolve({ sha: ev.sha }))
    })

    const state = supervisor.attach({
      sessionId: "sess_test",
      gate: { command: "true" },
      then: "commit",
      commit: { paths: ["src/a.ts"], message: "feat: auto", requireHumanAck: false },
    })

    fireTurnEnd(bus)

    const ev = await committedEvent
    expect(ev.sha).toBe(FAKE_SHA)
    await wait(20)
    expect(supervisor.getStatus(state.policyId)?.status).toBe("done")
    // No human gate when requireHumanAck:false.
    expect(ready).not.toHaveBeenCalled()
    const addCall = calls.find(c => c.command === "git" && c.args[0] === "add")
    expect(addCall?.args).toEqual(["add", "--", "src/a.ts"])
    assertNoForbiddenArgv(calls)
  })

  it("(e) empty paths → attach throws (no commit possible)", () => {
    const { exec } = makeGitMock()
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry: makeMockRegistry(workspace),
      sessionEvents: bus,
      workspace,
      runCommand: exec,
    })

    expect(() =>
      supervisor.attach({
        sessionId: "sess_test",
        then: "commit",
        commit: { paths: [], message: "feat: empty" },
      }),
    ).toThrow(/non-empty paths/)
  })

  it("(f) 'nothing to commit' is treated as success", async () => {
    const { exec } = makeGitMock({
      commitExitCode: 1,
      commitOut: "nothing to commit, working tree clean\n",
    })
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry: makeMockRegistry(workspace),
      sessionEvents: bus,
      workspace,
      runCommand: exec,
    })

    const committedEvent = new Promise<string>(resolve => {
      bus.on("policy:committed", ev => resolve(ev.sha))
    })

    const state = supervisor.attach({
      sessionId: "sess_test",
      gate: { command: "true" },
      then: "commit",
      commit: { paths: ["src/a.ts"], message: "feat: noop", requireHumanAck: false },
    })

    fireTurnEnd(bus)
    expect(await committedEvent).toBe(FAKE_SHA)
    expect(supervisor.getStatus(state.policyId)?.status).toBe("done")
  })

  it("(g) awaiting-ack persists + re-arms (still ack-able after reload)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agentproto-sup-wp5-"))
    const persistPath = join(tmp, "policies.json")

    const mock1 = makeGitMock()
    const bus1 = createSessionEventBus()
    const sup1 = createCompletionPolicySupervisor({
      registry: makeRegistryWithStatus(workspace),
      sessionEvents: bus1,
      workspace,
      persistPath,
      runCommand: mock1.exec,
    })
    const state = sup1.attach({
      sessionId: "sess_test",
      gate: { command: "true" },
      then: "commit",
      commit: { paths: ["src/a.ts"], message: "feat: persist" },
    })
    fireTurnEnd(bus1)
    await waitFor(() => sup1.getStatus(state.policyId)?.status === "awaiting-ack")
    sup1.shutdown()

    // Restart — policy must still be awaiting-ack, and ack must commit.
    const mock2 = makeGitMock()
    const bus2 = createSessionEventBus()
    const sup2 = createCompletionPolicySupervisor({
      registry: makeRegistryWithStatus(workspace),
      sessionEvents: bus2,
      workspace,
      persistPath,
      runCommand: mock2.exec,
    })
    expect(sup2.getStatus(state.policyId)?.status).toBe("awaiting-ack")
    expect(sup2.getStatus(state.policyId)?.commitPlan?.paths).toEqual(["src/a.ts"])

    const acked = await sup2.ack(state.policyId, true)
    expect(acked?.status).toBe("done")
    expect(acked?.commitSha).toBe(FAKE_SHA)
    const addCall = mock2.calls.find(c => c.command === "git" && c.args[0] === "add")
    expect(addCall?.args).toEqual(["add", "--", "src/a.ts"])
    assertNoForbiddenArgv(mock2.calls)

    await rm(tmp, { recursive: true, force: true })
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

// ── WP6: DAG chaining + concurrency cap ───────────────────────────────

describe("WP6 — DAG chaining + concurrency cap", () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await makeWorkspace(["true", "false"])
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it("(a) policy A with `next` B → when A is done, B is attached and watching", async () => {
    const ids = ["sA", "sB"]
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry: makeMultiRegistry(workspace, ids),
      sessionEvents: bus,
      workspace,
    })

    const stateA = supervisor.attach({
      sessionId: "sA",
      gate: { command: "true" },
      then: "emit",
      next: { sessionId: "sB", gate: { command: "true" }, then: "emit" },
    })

    // Before A completes, only A exists — B is NOT attached yet.
    expect(supervisor.list()).toHaveLength(1)

    // A finishes its turn → gate passes → A done → B chained.
    fireTurnEnd(bus, "sA")
    await waitFor(() => supervisor.getStatus(stateA.policyId)?.status === "done")

    const childId = supervisor.getStatus(stateA.policyId)?.nextPolicyId
    expect(childId).toBeDefined()
    expect(childId).toMatch(/^policy_/)
    expect(childId).not.toBe(stateA.policyId)

    const childB = supervisor.getStatus(childId!)
    expect(childB?.status).toBe("watching")
    expect(childB?.sessionIds).toEqual(["sB"])
    expect(supervisor.list()).toHaveLength(2)

    // Idempotent: A's subscriptions are gone, and even a stray re-fire must not
    // chain a second child.
    fireTurnEnd(bus, "sA")
    await wait(30)
    expect(supervisor.list()).toHaveLength(2)
    expect(supervisor.getStatus(stateA.policyId)?.nextPolicyId).toBe(childId)

    // The chain advances independently: B's own turn-end completes B.
    const passedB = new Promise<string>(resolve => {
      bus.on("policy:passed", ev => {
        if (ev.policyId === childId) resolve(ev.policyId)
      })
    })
    fireTurnEnd(bus, "sB")
    await waitFor(() => supervisor.getStatus(childId!)?.status === "done")
    expect(await passedB).toBe(childId)
  })

  it("(b) concurrency cap: with cap=2, a 3rd triggered policy waits for a slot", async () => {
    const ids = ["s1", "s2", "s3"]
    const bus = createSessionEventBus()

    // Controllable gate runner: each gate call blocks until its resolver is
    // invoked, letting the test hold policies in `gating`.
    const gates: Array<() => void> = []
    const exec = vi.fn(async () => {
      await new Promise<void>(res => gates.push(res))
      return mkResult({ exitCode: 0 })
    })

    const supervisor = createCompletionPolicySupervisor({
      registry: makeMultiRegistry(workspace, ids),
      sessionEvents: bus,
      workspace,
      runCommand: exec,
      concurrencyCap: 2,
    })

    const states = ids.map(id =>
      supervisor.attach({ sessionId: id, gate: { command: "true" }, then: "emit" }),
    )

    // Trigger all three at once.
    ids.forEach(id => fireTurnEnd(bus, id))

    // Cap=2 → exactly two gates run; the third is parked in `queued`.
    await waitFor(() => exec.mock.calls.length === 2)
    await wait(30)
    expect(exec).toHaveBeenCalledTimes(2)
    expect(supervisor.getStatus(states[0]!.policyId)?.status).toBe("gating")
    expect(supervisor.getStatus(states[1]!.policyId)?.status).toBe("gating")
    expect(supervisor.getStatus(states[2]!.policyId)?.status).toBe("queued")

    // Release the first gate → its policy reaches done → a slot frees → the
    // queued policy is admitted and its gate finally runs. (Which of the two
    // initially-running policies resolves first is non-deterministic — both
    // sit behind an async allowlist read — so assert on aggregate invariants,
    // not on a specific policy id.)
    gates[0]!()
    await waitFor(() => exec.mock.calls.length === 3)
    const statuses = states.map(s => supervisor.getStatus(s.policyId)?.status)
    // The queued policy (s3) has been admitted and is now gating.
    expect(supervisor.getStatus(states[2]!.policyId)?.status).toBe("gating")
    // Exactly one of the first two completed (that's what freed the slot), and
    // nothing remains queued.
    expect(statuses.filter(s => s === "done")).toHaveLength(1)
    expect(statuses.filter(s => s === "queued")).toHaveLength(0)

    // Drain the remaining gates so nothing dangles.
    gates[1]!()
    gates[2]!()
    await waitFor(() =>
      states.every(s => supervisor.getStatus(s.policyId)?.status === "done"),
    )
  })

  it("(c) chaining (`next`) persists + re-arms across a restart", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agentproto-sup-wp6-"))
    const persistPath = join(tmp, "policies.json")
    const ids = ["sA", "sB"]

    const bus1 = createSessionEventBus()
    const sup1 = createCompletionPolicySupervisor({
      registry: makeMultiRegistry(workspace, ids),
      sessionEvents: bus1,
      workspace,
      persistPath,
    })
    const stateA = sup1.attach({
      sessionId: "sA",
      gate: { command: "true" },
      then: "emit",
      next: { sessionId: "sB", gate: { command: "true" }, then: "emit" },
    })
    // Persist while A is still watching (its turn-end hasn't fired).
    sup1.shutdown()

    // Restart — A re-armed to watching, with its `next` spec intact.
    const bus2 = createSessionEventBus()
    const sup2 = createCompletionPolicySupervisor({
      registry: makeMultiRegistry(workspace, ids),
      sessionEvents: bus2,
      workspace,
      persistPath,
    })
    expect(sup2.getStatus(stateA.policyId)?.status).toBe("watching")

    // Completing A AFTER the reload must chain B — proving `next` survived the
    // restart (if it hadn't, no child would ever appear).
    fireTurnEnd(bus2, "sA")
    await waitFor(() => sup2.getStatus(stateA.policyId)?.status === "done")

    const childId = sup2.getStatus(stateA.policyId)?.nextPolicyId
    expect(childId).toBeDefined()
    const childB = sup2.getStatus(childId!)
    expect(childB?.status).toBe("watching")
    expect(childB?.sessionIds).toEqual(["sB"])

    await rm(tmp, { recursive: true, force: true })
  })
})

// ── Regression: gate cwd must anchor to the SESSION's own cwd, not the
// daemon's boot-time workspace — a session spawned in a sibling worktree
// (the dominant real usage pattern) must still be able to gate at all.
describe("gate cwd — session cwd outside the daemon's boot workspace", () => {
  let daemonWorkspace: string
  let sessionCwd: string

  beforeEach(async () => {
    daemonWorkspace = await makeWorkspace(["true"])
    // Sibling directory, NOT nested inside daemonWorkspace — mirrors a
    // feature worktree spawned next to the daemon's main checkout via
    // `agent_start({ cwd: <absolute-worktree-path> })`.
    sessionCwd = await mkdtemp(join(tmpdir(), "agentproto-session-worktree-"))
  })

  afterEach(async () => {
    await rm(daemonWorkspace, { recursive: true, force: true })
    await rm(sessionCwd, { recursive: true, force: true })
  })

  it("gate resolves against the session's own cwd instead of throwing 'cwd escapes the workspace'", async () => {
    const { exec, calls } = makeGitMock()
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry: makeMockRegistry(sessionCwd),
      sessionEvents: bus,
      workspace: daemonWorkspace,
      runCommand: exec,
    })

    const state = supervisor.attach({
      sessionId: "sess_test",
      gate: { command: "true" },
      then: "emit",
    })

    bus.emit({
      type: "session:turn-end",
      sessionId: "sess_test",
      awaitingInput: false,
      ts: new Date().toISOString(),
    })

    await waitFor(() => {
      const s = supervisor.getStatus(state.policyId)?.status
      return s === "done" || s === "blocked"
    })

    const finalState = supervisor.getStatus(state.policyId)
    // Pre-fix this settled "blocked" with error "cwd escapes the workspace:
    // '<sessionCwd>' (workspace=<daemonWorkspace>)" — the anchor was built
    // from the daemon's own boot workspace instead of the session's cwd.
    expect(finalState?.status).toBe("done")
    expect(finalState?.error).toBeUndefined()
    // The gate command actually ran in the session's own cwd (the sibling
    // worktree), never the daemon's boot workspace.
    expect(calls.some(c => c.cwd === sessionCwd)).toBe(true)
    expect(calls.some(c => c.cwd === daemonWorkspace)).toBe(false)
  })

  it("an explicit gate.cwd override is still anchored — but to the session's own cwd", async () => {
    const { exec, calls } = makeGitMock()
    const bus = createSessionEventBus()
    const supervisor = createCompletionPolicySupervisor({
      registry: makeMockRegistry(sessionCwd),
      sessionEvents: bus,
      workspace: daemonWorkspace,
      runCommand: exec,
    })

    const state = supervisor.attach({
      sessionId: "sess_test",
      gate: { command: "true", cwd: "../../etc" },
      then: "emit",
    })

    bus.emit({
      type: "session:turn-end",
      sessionId: "sess_test",
      awaitingInput: false,
      ts: new Date().toISOString(),
    })

    await waitFor(() => {
      const s = supervisor.getStatus(state.policyId)?.status
      return s === "done" || s === "blocked"
    })

    const finalState = supervisor.getStatus(state.policyId)
    expect(finalState?.status).toBe("blocked")
    expect(finalState?.error).toMatch(/cwd escapes the workspace/)
    expect(calls.length).toBe(0)
  })
})

// ── runShellGate() — the shared execution path used by both the turn-end
// policy gate above AND the semantic hook engine's action:"gate" (the
// agent-prompt pre-exec seam in sessions.ts). ─────────────────────────────

describe("runShellGate()", () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await makeWorkspace(["true", "false"])
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it("exit 0 → passed:true (the gate's \"allow\" case)", async () => {
    const outcome = await runShellGate({ command: "true" }, { workspace, sessionCwd: workspace })
    expect(outcome).toMatchObject({ kind: "ran", exitCode: 0, passed: true })
  })

  it("nonzero exit → passed:false (the gate's \"deny\" case)", async () => {
    const outcome = await runShellGate({ command: "false" }, { workspace, sessionCwd: workspace })
    expect(outcome).toMatchObject({ kind: "ran", exitCode: 1, passed: false })
  })

  it("a gate command not in allowed-commands.json → kind:\"not-allowlisted\"", async () => {
    const outcome = await runShellGate({ command: "rm" }, { workspace, sessionCwd: workspace })
    expect(outcome.kind).toBe("not-allowlisted")
    expect((outcome as { message: string }).message).toMatch(/not in allowlist/)
  })

  it("anchors an explicit gate.cwd against sessionCwd, not workspace", async () => {
    const sibling = await mkdtemp(join(tmpdir(), "agentproto-supervisor-sibling-"))
    try {
      await mkdir(join(sibling, "sub"))
      const calls: Array<{ cwd?: string }> = []
      const outcome = await runShellGate(
        { command: "true", cwd: "sub" },
        {
          workspace,
          sessionCwd: sibling,
          runCommand: async input => {
            calls.push({ cwd: input.cwd })
            return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 0 }
          },
        },
      )
      expect(outcome).toMatchObject({ kind: "ran", exitCode: 0, passed: true })
      expect(calls[0]?.cwd).toBe(join(sibling, "sub"))
    } finally {
      await rm(sibling, { recursive: true, force: true })
    }
  })

  it("an exec exception (e.g. a timeout) surfaces as kind:\"error\", not a throw", async () => {
    const outcome = await runShellGate(
      { command: "true" },
      {
        workspace,
        sessionCwd: workspace,
        runCommand: async () => {
          throw new Error("boom")
        },
      },
    )
    expect(outcome).toMatchObject({ kind: "error", message: "boom" })
  })
})
