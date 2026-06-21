import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createCompletionPolicySupervisor } from "../supervisor.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"
import type { SessionEventBus } from "../session-event-bus.js"

// ── Helpers ───────────────────────────────────────────────────────────

const JUDGE_ID = "judge_1"

/**
 * Mock registry for WP7 judge-gate tests. `spawnAgent` mints a fixed judge id;
 * `attach` replays `judgeReply` lines for the judge session (so the supervisor
 * parses a verdict from them) and nothing for the watched session.
 */
function makeJudgeRegistry(
  workspaceCwd: string,
  judgeReply: string[],
): SessionsRegistry {
  const watched: SessionDescriptor = {
    id: "sess_test",
    kind: "agent-cli",
    workspaceSlug: "test",
    command: "mock",
    pid: null,
    status: "running",
    startedAt: new Date().toISOString(),
    cwd: workspaceCwd,
  }
  const judge: SessionDescriptor = {
    id: JUDGE_ID,
    kind: "agent-cli",
    workspaceSlug: "test",
    command: "judge",
    pid: null,
    status: "running",
    startedAt: new Date().toISOString(),
    cwd: workspaceCwd,
  }
  return {
    get: vi.fn((id: string) =>
      id === "sess_test" ? watched : id === JUDGE_ID ? judge : undefined,
    ),
    findByIdOrName: vi.fn((q: string) => (q === "sess_test" ? watched : undefined)),
    spawn: vi.fn(),
    register: vi.fn(),
    spawnAgent: vi.fn(() => judge),
    spawnPty: vi.fn(),
    sendPrompt: vi.fn(async () => {}),
    enqueuePrompt: vi.fn(),
    list: vi.fn(() => []),
    attach: vi.fn((id: string, onLine: (line: string, stream: "stdout" | "stderr") => void) => {
      const lines = id === JUDGE_ID ? judgeReply : []
      for (const l of lines) onLine(l, "stdout")
      return () => {}
    }),
    attachPty: vi.fn(() => null),
    writeTerminalInput: vi.fn(() => false),
    readTerminalOutput: vi.fn(() => null),
    kill: vi.fn(() => true),
    forget: vi.fn(() => true),
    shutdown: vi.fn(),
  } as unknown as SessionsRegistry
}

/** Resolver that hands back a no-op agent session (no real LLM). */
function makeResolver() {
  return vi.fn(async (_slug: string) => ({
    startSession: vi.fn(async () => ({}) as unknown),
    commandPreview: "judge (agent)",
  }))
}

async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "agentproto-wp7-test-"))
  await mkdir(join(workspace, ".agentproto"), { recursive: true })
  await writeFile(
    join(workspace, ".agentproto", "allowed-commands.json"),
    JSON.stringify({ version: 1, commands: ["true", "false"] }),
    "utf8",
  )
  return workspace
}

function wait(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("waitFor timed out")
    await wait(5)
  }
}

function fireTurnEnd(bus: SessionEventBus, sessionId: string): void {
  bus.emit({
    type: "session:turn-end",
    sessionId,
    awaitingInput: false,
    ts: new Date().toISOString(),
  })
}

/** Number of sendPrompt calls targeting the judge session. */
function judgePrompted(registry: SessionsRegistry): boolean {
  return vi.mocked(registry.sendPrompt).mock.calls.some(c => c[0] === JUDGE_ID)
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("CompletionPolicySupervisor — WP7 judge-gate", () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await makeWorkspace()
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it("(a) trigger fires → judge agent is spawned and prompted with the rubric", async () => {
    const bus = createSessionEventBus()
    const registry = makeJudgeRegistry(workspace, ["VERDICT: PASS"])
    const resolveAgentAdapter = makeResolver()
    const supervisor = createCompletionPolicySupervisor({
      registry,
      sessionEvents: bus,
      workspace,
      resolveAgentAdapter,
    })

    supervisor.attach({
      sessionId: "sess_test",
      gate: { judge: { adapter: "claude-code", prompt: "Is the work correct?" } },
      then: "emit",
    })

    fireTurnEnd(bus, "sess_test")

    await waitFor(() => judgePrompted(registry))
    expect(registry.spawnAgent).toHaveBeenCalledTimes(1)
    expect(resolveAgentAdapter).toHaveBeenCalledWith("claude-code")
    const judgeCall = vi
      .mocked(registry.sendPrompt)
      .mock.calls.find(c => c[0] === JUDGE_ID)!
    expect(judgeCall[1]).toContain("Is the work correct?")
    expect(judgeCall[1]).toContain("VERDICT: PASS")
  })

  it("(b) verdict PASS → policy:passed + judge killed", async () => {
    const bus = createSessionEventBus()
    const registry = makeJudgeRegistry(workspace, ["some reasoning", "VERDICT: PASS"])
    const supervisor = createCompletionPolicySupervisor({
      registry,
      sessionEvents: bus,
      workspace,
      resolveAgentAdapter: makeResolver(),
    })

    const passed: string[] = []
    bus.on("policy:passed", ev => passed.push(ev.policyId))

    const state = supervisor.attach({
      sessionId: "sess_test",
      gate: { judge: { adapter: "claude-code", prompt: "ok?" } },
      then: "emit",
    })

    fireTurnEnd(bus, "sess_test")
    await waitFor(() => judgePrompted(registry))
    fireTurnEnd(bus, JUDGE_ID) // judge finished its turn

    await waitFor(() => supervisor.getStatus(state.policyId)?.status === "done")
    expect(passed).toContain(state.policyId)
    expect(registry.kill).toHaveBeenCalledWith(JUDGE_ID)
  })

  it("(c) verdict FAIL → policy fails and nudges the watched session (onFail)", async () => {
    const bus = createSessionEventBus()
    const registry = makeJudgeRegistry(workspace, ["nope", "VERDICT: FAIL"])
    const supervisor = createCompletionPolicySupervisor({
      registry,
      sessionEvents: bus,
      workspace,
      resolveAgentAdapter: makeResolver(),
    })

    const state = supervisor.attach({
      sessionId: "sess_test",
      gate: { judge: { adapter: "claude-code", prompt: "ok?" } },
      then: "emit",
      onFail: { nudge: "fix it ({code})", maxRetries: 2 },
    })

    fireTurnEnd(bus, "sess_test")
    await waitFor(() => judgePrompted(registry))
    fireTurnEnd(bus, JUDGE_ID)

    // Judge FAIL → nudge the watched session, return to watching.
    await waitFor(() =>
      vi.mocked(registry.sendPrompt).mock.calls.some(c => c[0] === "sess_test"),
    )
    expect(registry.sendPrompt).toHaveBeenCalledWith("sess_test", "fix it (1)")
    await waitFor(() => supervisor.getStatus(state.policyId)?.status === "watching")
    expect(supervisor.getStatus(state.policyId)?.retries).toBe(1)
    expect(registry.kill).toHaveBeenCalledWith(JUDGE_ID)
  })

  it("(c2) verdict FAIL, no onFail → policy:failed (blocked)", async () => {
    const bus = createSessionEventBus()
    const registry = makeJudgeRegistry(workspace, ["VERDICT: FAIL"])
    const supervisor = createCompletionPolicySupervisor({
      registry,
      sessionEvents: bus,
      workspace,
      resolveAgentAdapter: makeResolver(),
    })

    const failed: string[] = []
    bus.on("policy:failed", ev => failed.push(ev.policyId))

    const state = supervisor.attach({
      sessionId: "sess_test",
      gate: { judge: { adapter: "claude-code", prompt: "ok?" } },
      then: "emit",
    })

    fireTurnEnd(bus, "sess_test")
    await waitFor(() => judgePrompted(registry))
    fireTurnEnd(bus, JUDGE_ID)

    await waitFor(() => supervisor.getStatus(state.policyId)?.status === "blocked")
    expect(failed).toContain(state.policyId)
    expect(registry.kill).toHaveBeenCalledWith(JUDGE_ID)
  })

  it("(d1) unparseable verdict → FAIL fail-safe (+ reason) + judge killed", async () => {
    const bus = createSessionEventBus()
    const registry = makeJudgeRegistry(workspace, ["I cannot decide right now"])
    const supervisor = createCompletionPolicySupervisor({
      registry,
      sessionEvents: bus,
      workspace,
      resolveAgentAdapter: makeResolver(),
    })

    const state = supervisor.attach({
      sessionId: "sess_test",
      gate: { judge: { adapter: "claude-code", prompt: "ok?" } },
      then: "emit",
    })

    fireTurnEnd(bus, "sess_test")
    await waitFor(() => judgePrompted(registry))
    fireTurnEnd(bus, JUDGE_ID)

    await waitFor(() => supervisor.getStatus(state.policyId)?.status === "blocked")
    expect(supervisor.getStatus(state.policyId)?.error).toMatch(/VERDICT/i)
    expect(registry.kill).toHaveBeenCalledWith(JUDGE_ID)
  })

  it("(d2) judge timeout → FAIL fail-safe (+ reason) + judge killed", async () => {
    const bus = createSessionEventBus()
    const registry = makeJudgeRegistry(workspace, ["VERDICT: PASS"])
    const supervisor = createCompletionPolicySupervisor({
      registry,
      sessionEvents: bus,
      workspace,
      resolveAgentAdapter: makeResolver(),
    })

    const state = supervisor.attach({
      sessionId: "sess_test",
      // Short timeout; we never emit the judge's turn-end → it must time out.
      gate: { judge: { adapter: "claude-code", prompt: "ok?", timeoutMs: 60 } },
      then: "emit",
    })

    fireTurnEnd(bus, "sess_test")
    await waitFor(() => judgePrompted(registry))
    // Deliberately do NOT fire the judge's turn-end.

    await waitFor(() => supervisor.getStatus(state.policyId)?.status === "blocked")
    expect(supervisor.getStatus(state.policyId)?.error).toMatch(/timed out/i)
    expect(registry.kill).toHaveBeenCalledWith(JUDGE_ID)
  })

  it("(d3) no resolver wired → judge gate fails fail-safe without spawning", async () => {
    const bus = createSessionEventBus()
    const registry = makeJudgeRegistry(workspace, ["VERDICT: PASS"])
    const supervisor = createCompletionPolicySupervisor({
      registry,
      sessionEvents: bus,
      workspace,
      // no resolveAgentAdapter
    })

    const state = supervisor.attach({
      sessionId: "sess_test",
      gate: { judge: { adapter: "claude-code", prompt: "ok?" } },
      then: "emit",
    })

    fireTurnEnd(bus, "sess_test")
    await waitFor(() => supervisor.getStatus(state.policyId)?.status === "blocked")
    expect(registry.spawnAgent).not.toHaveBeenCalled()
    expect(supervisor.getStatus(state.policyId)?.error).toMatch(/not enabled/i)
  })
})
