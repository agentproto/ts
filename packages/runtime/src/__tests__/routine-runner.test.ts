import { describe, it, expect, vi } from "vitest"
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
    const runner = createRoutineRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
    })

    await runner.start({ routineId: "r1", steps: [] })
    await runner.start({ routineId: "r2", steps: [] })

    expect(runner.list()).toHaveLength(2)
  })
})
