import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createCompletionPolicySupervisor } from "../supervisor.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"
import type { SessionEventBus } from "../session-event-bus.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { ExecuteResult } from "../command-tools.js"

/**
 * Regression coverage for the "gate.mjs" class of defect: a judge-agent gate
 * rendering a verdict that contradicts an already-known MACHINE result,
 * because that result was never handed to the judge's prompt. See
 * `findRecentMachineGateResult`'s doc in supervisor.ts for the fix.
 */

const JUDGE_ID = "judge_1"

function makeJudgeRegistry(workspaceCwd: string, judgeReply: string[]): SessionsRegistry {
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
  const other: SessionDescriptor = {
    id: "sess_other",
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
      id === "sess_test" ? watched : id === "sess_other" ? other : id === JUDGE_ID ? judge : undefined,
    ),
    findByIdOrName: vi.fn((q: string) => (q === "sess_test" ? watched : q === "sess_other" ? other : undefined)),
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

function makeResolver(): AgentAdapterResolver {
  return vi.fn(async (_slug: string) => ({
    startSession: vi.fn(async () => ({}) as unknown),
    commandPreview: "judge (agent)",
  })) as unknown as AgentAdapterResolver
}

async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "agentproto-judge-gt-test-"))
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

function judgePrompted(registry: SessionsRegistry): boolean {
  return vi.mocked(registry.sendPrompt).mock.calls.some(c => c[0] === JUDGE_ID)
}

function judgePromptText(registry: SessionsRegistry): string {
  const call = vi.mocked(registry.sendPrompt).mock.calls.find(c => c[0] === JUDGE_ID)
  return call ? (call[1] as string) : ""
}

function failingShellResult(stdout: string): ExecuteResult {
  return { exitCode: 1, signal: null, stdout, stderr: "", durationMs: 5 }
}

function passingShellResult(stdout: string): ExecuteResult {
  return { exitCode: 0, signal: null, stdout, stderr: "", durationMs: 5 }
}

describe("CompletionPolicySupervisor — judge-gate ground-truth cross-check", () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await makeWorkspace()
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it("an independently-attached judge gate sibling to a FAILED shell gate on the same session is handed the failure as ground truth", async () => {
    const bus = createSessionEventBus()
    // The judge, left uninformed, would say PASS — reproducing the incident
    // ("no correctness regressions found" despite a known test failure).
    const registry = makeJudgeRegistry(workspace, ["looks fine to me", "VERDICT: PASS"])
    const exec = vi.fn(async () => failingShellResult("Test Files 18 failed | 61 passed (79)"))
    const supervisor = createCompletionPolicySupervisor({
      registry,
      sessionEvents: bus,
      workspace,
      resolveAgentAdapter: makeResolver(),
      runCommand: exec,
    })

    // Attach + settle the shell gate FIRST — mirrors the real incident, where
    // the machine check (turbo run test/check-types) had already produced its
    // result before anything downstream looked at it. This also removes a
    // race: both policies watch the same session, and if attached together
    // there is no guarantee the shell gate's result lands before the judge's
    // gate reads it.
    const shellState = supervisor.attach({
      sessionId: "sess_test",
      gate: { command: "true" },
      then: "emit",
    })
    fireTurnEnd(bus, "sess_test")
    await waitFor(() => supervisor.getStatus(shellState.policyId)?.status === "blocked")

    // Now independently attach the judge gate on the SAME session — no
    // `next` relationship, just two sibling policies watching one session.
    const judgeState = supervisor.attach({
      sessionId: "sess_test",
      gate: { judge: { adapter: "claude-code", prompt: "Did the tests pass? Any regressions?" } },
      then: "emit",
    })
    fireTurnEnd(bus, "sess_test")
    await waitFor(() => judgePrompted(registry))

    const prompt = judgePromptText(registry)
    expect(prompt).toContain("Did the tests pass?")
    expect(prompt).toContain("Known machine result")
    expect(prompt).toContain("FAILED")
    expect(prompt).toContain("Test Files 18 failed | 61 passed (79)")
    expect(prompt).toMatch(/authoritative/i)

    // Let the judge finish so the gate settles (mock still says PASS — this
    // suite verifies the ground truth is TRANSMITTED, not that it forces an
    // override of the judge's own final decision; see supervisor.ts's doc
    // on why a hard veto was rejected).
    fireTurnEnd(bus, JUDGE_ID)
    await waitFor(() => supervisor.getStatus(judgeState.policyId)?.status === "done")
  })

  it("a judge gate DAG-chained (`next`) after a PASSED shell gate receives that gate's actual result as context", async () => {
    const bus = createSessionEventBus()
    const registry = makeJudgeRegistry(workspace, ["all good", "VERDICT: PASS"])
    const exec = vi.fn(async () => passingShellResult("Test Files 79 passed (79)"))
    const supervisor = createCompletionPolicySupervisor({
      registry,
      sessionEvents: bus,
      workspace,
      resolveAgentAdapter: makeResolver(),
      runCommand: exec,
    })

    const parent = supervisor.attach({
      sessionId: "sess_test",
      gate: { command: "true" },
      then: "emit",
      next: {
        sessionId: "sess_test",
        gate: { judge: { adapter: "claude-code", prompt: "Review the change." } },
        then: "emit",
      },
    })

    // First turn-end: the shell gate runs, passes, and chains the judge gate
    // onto a fresh watch of the same session.
    fireTurnEnd(bus, "sess_test")
    await waitFor(() => supervisor.getStatus(parent.policyId)?.nextPolicyId !== undefined)

    // Second turn-end: only the newly-chained judge gate is listening now
    // (the parent's subscriptions are gone once it reached `done`).
    fireTurnEnd(bus, "sess_test")
    await waitFor(() => judgePrompted(registry))
    const prompt = judgePromptText(registry)
    expect(prompt).toContain("Known machine result")
    expect(prompt).toContain("PASSED")
    expect(prompt).toContain("Test Files 79 passed (79)")
  })

  it("a machine gate result on an unrelated session is never leaked into a judge gate watching a different session", async () => {
    const bus = createSessionEventBus()
    const registry = makeJudgeRegistry(workspace, ["VERDICT: PASS"])
    const exec = vi.fn(async () => failingShellResult("unrelated failure on sess_other"))
    const supervisor = createCompletionPolicySupervisor({
      registry,
      sessionEvents: bus,
      workspace,
      resolveAgentAdapter: makeResolver(),
      runCommand: exec,
    })

    // Shell gate fails on a DIFFERENT session than the one the judge watches.
    supervisor.attach({ sessionId: "sess_other", gate: { command: "true" }, then: "emit" })
    supervisor.attach({
      sessionId: "sess_test",
      gate: { judge: { adapter: "claude-code", prompt: "Review the change." } },
      then: "emit",
    })

    fireTurnEnd(bus, "sess_other")
    fireTurnEnd(bus, "sess_test")

    await waitFor(() => judgePrompted(registry))
    const prompt = judgePromptText(registry)
    expect(prompt).not.toContain("Known machine result")
    expect(prompt).not.toContain("unrelated failure on sess_other")
  })
})
