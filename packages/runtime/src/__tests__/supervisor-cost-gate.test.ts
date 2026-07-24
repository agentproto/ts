import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createCompletionPolicySupervisor } from "../supervisor.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { SessionEventBus, PolicyFailedEvent, PolicyPassedEvent } from "../session-event-bus.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"
import type { UsageSnapshotRecord } from "../usage-rollup.js"

// A registry seeded with per-session usage snapshots so the cost gate can roll
// up a windowed spend without touching disk. Only the members the cost gate +
// collectSessionSnapshots touch are real; the rest throw if unexpectedly hit.
function makeSeededRegistry(
  sessions: Array<{
    desc: SessionDescriptor
    snapshots: UsageSnapshotRecord[]
  }>,
): SessionsRegistry {
  const byId = new Map(sessions.map(s => [s.desc.id, s]))
  return {
    get: vi.fn((id: string) => byId.get(id)?.desc),
    list: vi.fn(() => sessions.map(s => s.desc)),
    readUsageSnapshots: vi.fn(async (id: string) => byId.get(id)?.snapshots ?? []),
    findByIdOrName: vi.fn(),
    spawn: vi.fn(),
    register: vi.fn(),
    spawnAgent: vi.fn(),
    spawnPty: vi.fn(),
    sendPrompt: vi.fn(async () => {}),
    enqueuePrompt: vi.fn(),
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

function agentDesc(
  id: string,
  extra: Partial<SessionDescriptor> = {},
): SessionDescriptor {
  return {
    id,
    kind: "agent-cli",
    workspaceSlug: "test",
    command: "mock",
    pid: null,
    status: "running",
    startedAt: new Date().toISOString(),
    cwd: "/tmp",
    ...extra,
  }
}

function nowSnapshot(costUsd: number): UsageSnapshotRecord {
  return { ts: new Date().toISOString(), costUsd, source: "computed" }
}

const teamMax = {
  profileRef: "team-max",
  endpoint: "anthropic",
  method: "oauth-bearer" as const,
}

async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "agentproto-cost-gate-test-"))
  await mkdir(join(workspace, ".agentproto"), { recursive: true })
  await writeFile(
    join(workspace, ".agentproto", "allowed-commands.json"),
    JSON.stringify({ version: 1, commands: [] }),
    "utf8",
  )
  return workspace
}

function wait(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms))
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() >= deadline) throw new Error("waitFor timed out")
    await wait(10)
  }
}

describe("supervisor cost-budget gate", () => {
  let workspace: string
  let bus: SessionEventBus

  beforeEach(async () => {
    workspace = await makeWorkspace()
    bus = createSessionEventBus()
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it("session over its window budget → gate fails → policy:failed", async () => {
    const registry = makeSeededRegistry([
      { desc: agentDesc("sess_over"), snapshots: [nowSnapshot(10)] },
    ])
    const supervisor = createCompletionPolicySupervisor({ registry, sessionEvents: bus, workspace })

    const failed: PolicyFailedEvent[] = []
    const passed: PolicyPassedEvent[] = []
    bus.on("policy:failed", ev => failed.push(ev))
    bus.on("policy:passed", ev => passed.push(ev))

    const state = supervisor.attach({
      sessionId: "sess_over",
      gate: { costBudget: { maxCostUsd: 5, window: "1h", scope: "session" } },
      then: "emit",
    })

    bus.emit({ type: "session:turn-end", sessionId: "sess_over", awaitingInput: false, ts: new Date().toISOString() })

    await waitFor(() => supervisor.getStatus(state.policyId)?.status === "blocked")
    expect(failed).toHaveLength(1)
    expect(failed[0]!.policyId).toBe(state.policyId)
    expect(passed).toHaveLength(0)
    expect(supervisor.getStatus(state.policyId)?.error).toMatch(/cost budget tripped/)
  })

  it("session under its window budget → gate passes → policy:passed", async () => {
    const registry = makeSeededRegistry([
      { desc: agentDesc("sess_under"), snapshots: [nowSnapshot(3)] },
    ])
    const supervisor = createCompletionPolicySupervisor({ registry, sessionEvents: bus, workspace })

    const failed: PolicyFailedEvent[] = []
    const passed: PolicyPassedEvent[] = []
    bus.on("policy:failed", ev => failed.push(ev))
    bus.on("policy:passed", ev => passed.push(ev))

    const state = supervisor.attach({
      sessionId: "sess_under",
      gate: { costBudget: { maxCostUsd: 20, window: "1h", scope: "session" } },
      then: "emit",
    })

    bus.emit({ type: "session:turn-end", sessionId: "sess_under", awaitingInput: false, ts: new Date().toISOString() })

    await waitFor(() => supervisor.getStatus(state.policyId)?.status === "done")
    expect(passed).toHaveLength(1)
    expect(failed).toHaveLength(0)
  })

  it("profile scope sums every session on the same profile → trips over aggregate", async () => {
    // Two sessions on the same profile, $6 + $6 = $12 windowed spend.
    const registry = makeSeededRegistry([
      { desc: agentDesc("sess_a", { accessProfile: teamMax }), snapshots: [nowSnapshot(6)] },
      { desc: agentDesc("sess_b", { accessProfile: teamMax }), snapshots: [nowSnapshot(6)] },
    ])
    const supervisor = createCompletionPolicySupervisor({ registry, sessionEvents: bus, workspace })

    const failed: PolicyFailedEvent[] = []
    bus.on("policy:failed", ev => failed.push(ev))

    // Budget of $10 across the profile → $12 aggregate trips it, even though
    // sess_a alone ($6) would be under a session-scoped cap.
    const state = supervisor.attach({
      sessionId: "sess_a",
      gate: { costBudget: { maxCostUsd: 10, window: "1h", scope: "profile" } },
      then: "emit",
    })

    bus.emit({ type: "session:turn-end", sessionId: "sess_a", awaitingInput: false, ts: new Date().toISOString() })

    await waitFor(() => supervisor.getStatus(state.policyId)?.status === "blocked")
    expect(failed).toHaveLength(1)
  })

  it("unreadable snapshots → spend treated as 0 → gate passes", async () => {
    const registry = makeSeededRegistry([{ desc: agentDesc("sess_err"), snapshots: [] }])
    // Make the read throw — best-effort must swallow it and pass.
    ;(registry.readUsageSnapshots as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("corrupt transcript"),
    )
    const supervisor = createCompletionPolicySupervisor({ registry, sessionEvents: bus, workspace })

    const passed: PolicyPassedEvent[] = []
    bus.on("policy:passed", ev => passed.push(ev))

    const state = supervisor.attach({
      sessionId: "sess_err",
      gate: { costBudget: { maxCostUsd: 1, window: "1h", scope: "session" } },
      then: "emit",
    })

    bus.emit({ type: "session:turn-end", sessionId: "sess_err", awaitingInput: false, ts: new Date().toISOString() })

    await waitFor(() => supervisor.getStatus(state.policyId)?.status === "done")
    expect(passed).toHaveLength(1)
  })
})
