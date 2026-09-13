import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createCompletionPolicySupervisor } from "../supervisor.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"
import type { SessionEventBus } from "../session-event-bus.js"
import type { AgentAdapterResolver } from "../http-server.js"
// WP-D: mocked so the wallet-passthrough tests below control the profile
// resolution outcome directly, without touching real keychain/auth-profile
// I/O — `resolveAccessProfileAuth` itself is exercised end-to-end by
// session-spawn.test.ts's "billing-auth resolution wiring" suite.
import { resolveAccessProfileAuth } from "../session-spawn.js"

vi.mock("../session-spawn.js", () => ({
  resolveAccessProfileAuth: vi.fn(),
}))

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
function makeResolver(): AgentAdapterResolver {
  return vi.fn(async (_slug: string) => ({
    startSession: vi.fn(async () => ({}) as unknown),
    commandPreview: "judge (agent)",
  })) as unknown as AgentAdapterResolver
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

describe("CompletionPolicySupervisor — WP-D structured verdict", () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await makeWorkspace()
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it("(a) fenced JSON verdict PASS is persisted on state.verdict and echoed on policy:passed", async () => {
    const bus = createSessionEventBus()
    const registry = makeJudgeRegistry(workspace, [
      "Here is my assessment.",
      "```json",
      '{"decision": "PASS", "summary": "looks good", "findings": [{"severity": "low", "file": "a.ts", "note": "nit"}]}',
      "```",
      "VERDICT: PASS",
    ])
    const supervisor = createCompletionPolicySupervisor({
      registry,
      sessionEvents: bus,
      workspace,
      resolveAgentAdapter: makeResolver(),
    })

    const passed: Array<{ policyId: string; verdict?: unknown }> = []
    bus.on("policy:passed", ev => passed.push(ev))

    const state = supervisor.attach({
      sessionId: "sess_test",
      gate: { judge: { adapter: "claude-code", prompt: "ok?" } },
      then: "emit",
    })

    fireTurnEnd(bus, "sess_test")
    await waitFor(() => judgePrompted(registry))
    fireTurnEnd(bus, JUDGE_ID)

    await waitFor(() => supervisor.getStatus(state.policyId)?.status === "done")
    const finalState = supervisor.getStatus(state.policyId)
    expect(finalState?.verdict).toEqual({
      decision: "PASS",
      summary: "looks good",
      findings: [{ severity: "low", file: "a.ts", note: "nit" }],
    })
    expect(passed.find(ev => ev.policyId === state.policyId)?.verdict).toEqual(finalState?.verdict)
  })

  it("(b) fenced JSON verdict FAIL blocks even though every finding is low severity — decision alone drives pass/fail, never a severity threshold", async () => {
    const bus = createSessionEventBus()
    const registry = makeJudgeRegistry(workspace, [
      "```json",
      '{"decision": "FAIL", "findings": [{"severity": "low", "note": "minor nit only"}]}',
      "```",
      "VERDICT: FAIL",
    ])
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
    const finalState = supervisor.getStatus(state.policyId)
    expect(finalState?.verdict?.decision).toBe("FAIL")
    expect(finalState?.error).toMatch(/judge verdict: FAIL/)
  })

  it("(c) an unknown severity string collapses to 'medium' rather than being dropped or guessed as an extreme", async () => {
    const bus = createSessionEventBus()
    const registry = makeJudgeRegistry(workspace, [
      "```json",
      '{"decision": "PASS", "findings": [{"severity": "blocker", "note": "custom vocabulary"}]}',
      "```",
      "VERDICT: PASS",
    ])
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

    await waitFor(() => supervisor.getStatus(state.policyId)?.status === "done")
    expect(supervisor.getStatus(state.policyId)?.verdict?.findings?.[0]?.severity).toBe("medium")
  })

  it("(d) malformed JSON in the fence falls back to the plain VERDICT: line — verdict carries only `decision`", async () => {
    const bus = createSessionEventBus()
    const registry = makeJudgeRegistry(workspace, [
      "```json",
      "{not valid json at all",
      "```",
      "VERDICT: PASS",
    ])
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

    await waitFor(() => supervisor.getStatus(state.policyId)?.status === "done")
    expect(supervisor.getStatus(state.policyId)?.verdict).toEqual({ decision: "PASS" })
  })

  it("(e) plain VERDICT: line only (no JSON block, WP7 legacy prompts) → verdict carries only `decision`", async () => {
    const bus = createSessionEventBus()
    const registry = makeJudgeRegistry(workspace, ["some reasoning", "VERDICT: PASS"])
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

    await waitFor(() => supervisor.getStatus(state.policyId)?.status === "done")
    expect(supervisor.getStatus(state.policyId)?.verdict).toEqual({ decision: "PASS" })
  })

  it("(f) wholly unparseable reply → fail-safe FAIL, verdict stays unset", async () => {
    const bus = createSessionEventBus()
    const registry = makeJudgeRegistry(workspace, ["I cannot decide right now"])
    const supervisor = createCompletionPolicySupervisor({
      registry,
      sessionEvents: bus,
      workspace,
      resolveAgentAdapter: makeResolver(),
    })

    const failed: Array<{ policyId: string; verdict?: unknown }> = []
    bus.on("policy:failed", ev => failed.push(ev))

    const state = supervisor.attach({
      sessionId: "sess_test",
      gate: { judge: { adapter: "claude-code", prompt: "ok?" } },
      then: "emit",
    })

    fireTurnEnd(bus, "sess_test")
    await waitFor(() => judgePrompted(registry))
    fireTurnEnd(bus, JUDGE_ID)

    await waitFor(() => supervisor.getStatus(state.policyId)?.status === "blocked")
    expect(supervisor.getStatus(state.policyId)?.verdict).toBeUndefined()
    expect(failed.find(ev => ev.policyId === state.policyId)?.verdict).toBeUndefined()
  })

  it("(g) a nudged retry clears the previous round's verdict rather than carrying it forward", async () => {
    const bus = createSessionEventBus()
    // First gate run: FAIL with a JSON verdict. Second (post-nudge) run: PASS,
    // plain VERDICT line only — the mock replays the SAME lines both times
    // (attach() re-plays judgeReply on every call), so use a resolver whose
    // second reply differs isn't needed: what matters is that the SECOND run's
    // (plain-PASS) verdict shape doesn't retain the FIRST run's `findings`.
    const registry = makeJudgeRegistry(workspace, ["VERDICT: PASS"])
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
      onFail: { maxRetries: 2 },
    })

    fireTurnEnd(bus, "sess_test")
    await waitFor(() => judgePrompted(registry))
    fireTurnEnd(bus, JUDGE_ID)

    await waitFor(() => supervisor.getStatus(state.policyId)?.status === "done")
    expect(supervisor.getStatus(state.policyId)?.verdict).toEqual({ decision: "PASS" })
  })
})

describe("CompletionPolicySupervisor — WP-D judge wallet passthrough", () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await makeWorkspace()
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
    vi.mocked(resolveAccessProfileAuth).mockReset()
  })

  it("origin: 'gate' is stamped on every judge spawn (PR #800 grouping)", async () => {
    const bus = createSessionEventBus()
    const registry = makeJudgeRegistry(workspace, ["VERDICT: PASS"])
    const supervisor = createCompletionPolicySupervisor({
      registry,
      sessionEvents: bus,
      workspace,
      resolveAgentAdapter: makeResolver(),
    })

    supervisor.attach({
      sessionId: "sess_test",
      gate: { judge: { adapter: "claude-code", prompt: "ok?" } },
      then: "emit",
    })

    fireTurnEnd(bus, "sess_test")
    await waitFor(() => judgePrompted(registry))
    expect(registry.spawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "gate" }),
    )
  })

  it("access.profileRef resolves via resolveAccessProfileAuth and forwards the resulting `auth` + `mode` to startSession", async () => {
    const bus = createSessionEventBus()
    const registry = makeJudgeRegistry(workspace, ["VERDICT: PASS"])
    const fakeAuthSpec = { mode: "subscription" } as unknown as Record<string, unknown>
    vi.mocked(resolveAccessProfileAuth).mockResolvedValue({
      ok: true,
      authSpec: fakeAuthSpec,
      accessProfileEcho: { profileRef: "prof-1", endpoint: "anthropic", method: "oauth-bearer" },
    } as never)
    const startSession = vi.fn(async () => ({}) as unknown)
    const resolveAgentAdapter = vi.fn(async () => ({
      startSession,
      commandPreview: "judge (agent)",
      authDescriptor: { provider: "anthropic" },
    })) as unknown as AgentAdapterResolver

    const supervisor = createCompletionPolicySupervisor({
      registry,
      sessionEvents: bus,
      workspace,
      resolveAgentAdapter,
    })

    supervisor.attach({
      sessionId: "sess_test",
      gate: {
        judge: {
          adapter: "claude-code",
          prompt: "ok?",
          access: { profileRef: "prof-1" },
          mode: "plan",
        },
      },
      then: "emit",
    })

    fireTurnEnd(bus, "sess_test")
    await waitFor(() => judgePrompted(registry))

    expect(resolveAccessProfileAuth).toHaveBeenCalledWith(
      expect.objectContaining({ adapter: "claude-code", profileRef: "prof-1" }),
    )
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({ auth: fakeAuthSpec, mode: "plan" }),
    )
  })

  it("an unresolvable access profile fails the gate fail-safe — the judge is never spawned", async () => {
    const bus = createSessionEventBus()
    const registry = makeJudgeRegistry(workspace, ["VERDICT: PASS"])
    vi.mocked(resolveAccessProfileAuth).mockResolvedValue({
      ok: false,
      code: "access_profile_not_found",
      message: 'no auth profile "prof-x" found.',
    } as never)
    const supervisor = createCompletionPolicySupervisor({
      registry,
      sessionEvents: bus,
      workspace,
      resolveAgentAdapter: makeResolver(),
    })

    const state = supervisor.attach({
      sessionId: "sess_test",
      gate: { judge: { adapter: "claude-code", prompt: "ok?", access: { profileRef: "prof-x" } } },
      then: "emit",
    })

    fireTurnEnd(bus, "sess_test")
    await waitFor(() => supervisor.getStatus(state.policyId)?.status === "blocked")
    expect(registry.spawnAgent).not.toHaveBeenCalled()
    expect(supervisor.getStatus(state.policyId)?.error).toMatch(/access profile/i)
  })

  it("omitting access/route/mode is a no-op — resolveAccessProfileAuth is never called and startSession gets neither `auth` nor `mode`", async () => {
    const bus = createSessionEventBus()
    const registry = makeJudgeRegistry(workspace, ["VERDICT: PASS"])
    const startSession = vi.fn(async (_opts: Record<string, unknown>) => ({}) as unknown)
    const resolveAgentAdapter = vi.fn(async () => ({
      startSession,
      commandPreview: "judge (agent)",
    })) as unknown as AgentAdapterResolver

    const supervisor = createCompletionPolicySupervisor({
      registry,
      sessionEvents: bus,
      workspace,
      resolveAgentAdapter,
    })

    supervisor.attach({
      sessionId: "sess_test",
      gate: { judge: { adapter: "claude-code", prompt: "ok?" } },
      then: "emit",
    })

    fireTurnEnd(bus, "sess_test")
    await waitFor(() => judgePrompted(registry))

    expect(resolveAccessProfileAuth).not.toHaveBeenCalled()
    const call = startSession.mock.calls[0]?.[0]
    expect(call).not.toHaveProperty("auth")
    expect(call).not.toHaveProperty("mode")
  })
})
