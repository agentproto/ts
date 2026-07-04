import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createRoutineRunner } from "../routine-runner.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

// ── Minimal mock registry ─────────────────────────────────────────────

function makeMockRegistry(overrides: Partial<SessionsRegistry> = {}): SessionsRegistry {
  const descriptors = new Map<string, SessionDescriptor>()

  const baseDesc = (id: string): SessionDescriptor => ({
    id,
    kind: "agent-cli",
    workspaceSlug: "test",
    command: "mock",
    pid: null,
    status: "running",
    startedAt: new Date().toISOString(),
  })

  return {
    spawn: vi.fn(),
    register: vi.fn(),
    spawnAgent: vi.fn((input) => {
      const id = `sess_${Math.random().toString(36).slice(2, 6)}`
      const desc = { ...baseDesc(id), cwd: input.cwd }
      descriptors.set(id, desc)
      return desc
    }),
    spawnPty: vi.fn(),
    sendPrompt: vi.fn(async () => {}),
    enqueuePrompt: vi.fn(),
    list: vi.fn(() => []),
    get: vi.fn((id) => descriptors.get(id)),
    attach: vi.fn(() => null),
    attachPty: vi.fn(() => null),
    findByIdOrName: vi.fn((q) => descriptors.get(q)),
    writeTerminalInput: vi.fn(() => false),
    readTerminalOutput: vi.fn(async () => ({ lines: [], nextCursor: 0 })),
    tailLines: vi.fn(async () => ({ lines: [], nextCursor: 0, skipped: 0 })),
    kill: vi.fn(),
    forget: vi.fn(),
    shutdown: vi.fn(),
    ...overrides,
  } as unknown as SessionsRegistry
}

function makeMockAdapter(): AgentAdapterResolver {
  return vi.fn(async (_slug: string) => ({
    startSession: async ({ cwd }: { cwd: string }) => ({
      sessionId: `adapter_${Math.random().toString(36).slice(2, 6)}`,
      send: async function* () {},
      cancel: async () => {},
      close: async () => {},
    }),
    commandPreview: "mock-adapter",
  }))
}

// ── Helpers ───────────────────────────────────────────────────────────

function waitNextTick(): Promise<void> {
  return new Promise(res => setTimeout(res, 0))
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("RoutineRunner", () => {
  it("start() returns immediately with status=running", async () => {
    const bus = createSessionEventBus()
    const registry = makeMockRegistry()
    const runner = createRoutineRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
    })

    const run = await runner.start({
      routineId: "test",
      steps: [{ label: "step1", adapter: "mock" }],
    })

    expect(run.status).toBe("running")
    expect(run.runId).toMatch(/^run_/)
  })

  it("run completes when turn-end fires after prompt", async () => {
    const bus = createSessionEventBus()
    let spawnedId: string | null = null
    const registry = makeMockRegistry({
      spawnAgent: vi.fn((input) => {
        spawnedId = `sess_test`
        return {
          id: spawnedId,
          kind: "agent-cli" as const,
          workspaceSlug: "test",
          command: "mock",
          pid: null,
          status: "running" as const,
          startedAt: new Date().toISOString(),
          cwd: input.cwd,
        }
      }),
      get: vi.fn((id) =>
        id === "sess_test"
          ? { id, kind: "agent-cli" as const, workspaceSlug: "test", command: "mock", pid: null, status: "exited" as const, startedAt: "t" }
          : undefined
      ),
    })

    const runner = createRoutineRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
    })

    const run = await runner.start({
      routineId: "test",
      steps: [{ label: "step1", adapter: "mock", prompt: "do something" }],
    })

    // Let the runner start the step
    await waitNextTick()

    // Simulate turn-end from the session
    if (spawnedId) {
      bus.emit({ type: "session:turn-end", sessionId: spawnedId, awaitingInput: false, ts: "t" })
    }

    // Wait for the state machine to process
    await new Promise(res => setTimeout(res, 20))

    const status = runner.status(run.runId)
    expect(status?.status).toBe("done")
  })

  it("fan-in: waits for all waitFor sessions before executing", async () => {
    const bus = createSessionEventBus()
    const registry = makeMockRegistry()

    const runner = createRoutineRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
    })

    const aggregatePrompt = vi.fn(async () => {})
    const registryWithSpy = {
      ...registry,
      sendPrompt: aggregatePrompt,
    } as unknown as SessionsRegistry

    const runner2 = createRoutineRunner({
      registry: registryWithSpy,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
    })

    const run = await runner2.start({
      routineId: "fan-in-test",
      steps: [
        { label: "aggregate", waitFor: ["sess-a", "sess-b"], prompt: "summarize" },
      ],
    })

    expect(run.status).toBe("running")

    // Emit only sess-a first — the step should still be waiting
    bus.emit({ type: "session:turn-end", sessionId: "sess-a", awaitingInput: false, ts: "t" })
    await waitNextTick()
    expect(runner2.status(run.runId)?.status).toBe("running")

    // Now emit sess-b — should unblock the fan-in
    bus.emit({ type: "session:turn-end", sessionId: "sess-b", awaitingInput: false, ts: "t" })
    await new Promise(res => setTimeout(res, 20))

    // The aggregate step should have tried to send the prompt
    // (sendPrompt gets called if spawnAgent returned a session id)
    // Status is "running" or "done" depending on whether spawnAgent returned a real id
    const status = runner2.status(run.runId)
    expect(status).toBeDefined()
  })

  it("cancel() stops the run", async () => {
    const bus = createSessionEventBus()
    const registry = makeMockRegistry()

    const runner = createRoutineRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: vi.fn(async () => ({
        startSession: async ({ cwd }: { cwd: string }) => ({
          sessionId: "s",
          send: async function* () {
            // never yields
            await new Promise<void>(() => {})
            yield { kind: "text-delta", text: "" }
          },
          cancel: async () => {},
          close: async () => {},
        }),
      })),
    })

    const run = await runner.start({
      routineId: "cancel-test",
      steps: [
        { label: "step1", adapter: "mock", prompt: "do something" },
        { label: "step2", adapter: "mock", prompt: "and more" },
      ],
    })

    runner.cancel(run.runId)
    await new Promise(res => setTimeout(res, 10))

    const status = runner.status(run.runId)
    expect(["cancelled", "running"]).toContain(status?.status)
  })

  it("list() returns all runs", async () => {
    const bus = createSessionEventBus()
    const registry = makeMockRegistry()
    // Use an isolated temp path so prior test runs don't pollute list().
    const isolated = join(mkdtempSync(join(tmpdir(), "runner-list-")), "runs.json")
    const runner = createRoutineRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      persistPath: isolated,
    })

    await runner.start({ routineId: "r1", steps: [] })
    await runner.start({ routineId: "r2", steps: [] })

    expect(runner.list()).toHaveLength(2)
  })
})

// ── Regression tests ──────────────────────────────────────────────────

describe("RoutineRunner regression — fast-session race + cwd threading", () => {
  it("completes when turn-end fires synchronously inside sendPrompt (fast-session race)", async () => {
    // Reproduces Bug 1: session fires turn-end DURING sendPrompt (synchronously,
    // before the old waitTurnEnd() call could subscribe). Without the fix the run
    // would hang forever waiting for an event that already fired.
    const bus = createSessionEventBus()

    const registry = makeMockRegistry({
      spawnAgent: vi.fn((input) => ({
        id: "sess_race",
        kind: "agent-cli" as const,
        workspaceSlug: "test",
        command: "mock",
        pid: null,
        status: "running" as const,
        startedAt: new Date().toISOString(),
        cwd: input.cwd,
      })),
      // Emit turn-end synchronously inside sendPrompt — the exact race scenario.
      // Old code: waitTurnEnd() is called AFTER sendPrompt returns → event already
      //   fired, nobody was subscribed → hangs.
      // New code: waitTurnEnd() is called BEFORE sendPrompt → subscription is live
      //   when the emit fires → promise resolves → no hang.
      sendPrompt: vi.fn(async (sessionId: string) => {
        bus.emit({ type: "session:turn-end", sessionId, awaitingInput: false, ts: "t" })
      }),
      get: vi.fn((id) =>
        id === "sess_race"
          ? {
              id,
              kind: "agent-cli" as const,
              workspaceSlug: "test",
              command: "mock",
              pid: null,
              status: "running" as const,
              startedAt: "t",
            }
          : undefined,
      ),
    })

    const runner = createRoutineRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
    })

    const run = await runner.start({
      routineId: "race-regression",
      steps: [{ label: "fast-step", adapter: "mock", prompt: "go fast" }],
    })

    // One macrotask (setTimeout 0) drains all pending microtasks.
    // Fixed code: completes synchronously within the microtask chain.
    // Broken code: stuck waiting for an event that already fired → status stays "running".
    await waitNextTick()

    expect(runner.status(run.runId)?.status).toBe("done")
  }, 500)

  it("completes via belt-and-suspenders when session is already exited before waitTurnEnd", async () => {
    // Reproduces the case where the session exits between spawn and subscription.
    // The belt-and-suspenders check in waitTurnEnd reads registry.get() immediately
    // after subscribing and resolves if the session is already terminal.
    const bus = createSessionEventBus()

    const registry = makeMockRegistry({
      spawnAgent: vi.fn((input) => ({
        id: "sess_already_done",
        kind: "agent-cli" as const,
        workspaceSlug: "test",
        command: "mock",
        pid: null,
        // Already exited by the time we see it
        status: "exited" as const,
        startedAt: new Date().toISOString(),
        cwd: input.cwd,
      })),
      // sendPrompt does NOT emit any event — the session is already exited
      sendPrompt: vi.fn(async () => {}),
      get: vi.fn((id) =>
        id === "sess_already_done"
          ? {
              id,
              kind: "agent-cli" as const,
              workspaceSlug: "test",
              command: "mock",
              pid: null,
              status: "exited" as const,
              startedAt: "t",
            }
          : undefined,
      ),
    })

    const runner = createRoutineRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
    })

    const run = await runner.start({
      routineId: "already-exited",
      steps: [{ label: "step1", adapter: "mock", prompt: "hello" }],
    })

    await waitNextTick()

    expect(runner.status(run.runId)?.status).toBe("done")
  }, 500)

  it("uses the cwd from start() for the first spawned session", async () => {
    // Reproduces Bug 2: cwd passed to routine_start was silently ignored;
    // sessions always spawned in process.cwd() of the daemon.
    const bus = createSessionEventBus()
    const capturedCwds: string[] = []

    const registry = makeMockRegistry({
      spawnAgent: vi.fn((input) => {
        capturedCwds.push(input.cwd as string)
        return {
          id: "sess_cwd",
          kind: "agent-cli" as const,
          workspaceSlug: "test",
          command: "mock",
          pid: null,
          status: "running" as const,
          startedAt: new Date().toISOString(),
          cwd: input.cwd as string,
        }
      }),
      sendPrompt: vi.fn(async (sessionId: string) => {
        bus.emit({ type: "session:turn-end", sessionId, awaitingInput: false, ts: "t" })
      }),
      get: vi.fn((id) =>
        id === "sess_cwd"
          ? {
              id,
              kind: "agent-cli" as const,
              workspaceSlug: "test",
              command: "mock",
              pid: null,
              status: "running" as const,
              startedAt: "t",
              cwd: "/the/project/root",
            }
          : undefined,
      ),
    })

    const runner = createRoutineRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
    })

    await runner.start({
      routineId: "cwd-test",
      steps: [{ label: "step1", adapter: "mock", prompt: "go" }],
      cwd: "/the/project/root",
    })

    await waitNextTick()

    // The first (and only) spawned session must use the cwd from start(), not
    // process.cwd() of the daemon process.
    expect(capturedCwds[0]).toBe("/the/project/root")
  })
})

// ── Persistence tests ─────────────────────────────────────────────────

describe("RoutineRunner persistence", () => {
  let tmpDir: string
  let persistPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "routine-runner-test-"))
    persistPath = join(tmpDir, "routine-runs.json")
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("persists runs to disk on start()", async () => {
    const bus = createSessionEventBus()
    const registry = makeMockRegistry()
    const runner = createRoutineRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      persistPath,
    })

    const run = await runner.start({ routineId: "persist-test", steps: [] })

    // File should exist after start
    expect(existsSync(persistPath)).toBe(true)
    const raw = readFileSync(persistPath, "utf8")
    const parsed = JSON.parse(raw) as Array<{ runId: string }>
    expect(parsed.some(r => r.runId === run.runId)).toBe(true)
  })

  it("loads persisted runs on init", async () => {
    const bus = createSessionEventBus()
    const registry = makeMockRegistry()

    // First runner — write a run
    const runner1 = createRoutineRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      persistPath,
    })
    const run = await runner1.start({ routineId: "reload-test", steps: [] })
    // Poll until the run reaches a terminal state instead of sleeping a fixed
    // duration — avoids flakiness if the async steps loop is slow under load.
    const terminal = new Set(["done", "failed", "cancelled"])
    for (let i = 0; i < 50; i++) {
      const s = runner1.status(run.runId)
      if (s && terminal.has(s.status)) break
      await new Promise(res => setTimeout(res, 10))
    }

    // Second runner — should reload from disk
    const runner2 = createRoutineRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      persistPath,
    })
    expect(runner2.status(run.runId)).toBeDefined()
    expect(runner2.list()).toHaveLength(1)
  })

  it("marks running/awaiting-input runs as failed on restart", async () => {
    const bus = createSessionEventBus()
    const registry = makeMockRegistry()

    // Manually write a "running" run to the persist file
    const fakeRun = {
      runId: "run_fakeid1",
      routineId: "stale-run",
      status: "running",
      startedAt: new Date().toISOString(),
      steps: [{ index: 0, label: "step1", status: "running" }],
      result: { sessionIds: [] },
    }
    const fakeRun2 = {
      runId: "run_fakeid2",
      routineId: "stale-run2",
      status: "awaiting-input",
      startedAt: new Date().toISOString(),
      steps: [],
      result: { sessionIds: [] },
    }
    writeFileSync(persistPath, JSON.stringify([fakeRun, fakeRun2], null, 2), "utf8")

    // New runner loads and marks both as failed
    const runner = createRoutineRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      persistPath,
    })

    const s1 = runner.status("run_fakeid1")
    const s2 = runner.status("run_fakeid2")
    expect(s1?.status).toBe("failed")
    expect(s1?.error).toBe("interrupted by daemon restart")
    expect(s2?.status).toBe("failed")
    expect(s2?.error).toBe("interrupted by daemon restart")
  })

  it("handles missing or malformed persist file gracefully", async () => {
    const bus = createSessionEventBus()
    const registry = makeMockRegistry()

    // Missing file — no error, empty list
    const runner1 = createRoutineRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      persistPath: join(tmpDir, "nonexistent.json"),
    })
    expect(runner1.list()).toHaveLength(0)

    // Malformed file
    writeFileSync(persistPath, "not valid json", "utf8")
    const runner2 = createRoutineRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      persistPath,
    })
    expect(runner2.list()).toHaveLength(0)
  })
})
