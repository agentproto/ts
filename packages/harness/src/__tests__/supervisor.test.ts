import { describe, it, expect, vi } from "vitest"
import { buildSupervisorArgs, createSupervisorHarness } from "../harnesses/supervisor.js"
import type { WorkPackage } from "../wp.js"

const WPS: WorkPackage[] = [
  { id: "WP1", title: "Add auth", description: "Implement JWT middleware", gate: "pnpm test" },
  { id: "WP2", title: "Write tests", description: "Unit tests for auth", gate: "pnpm test" },
]

describe("buildSupervisorArgs", () => {
  it("defaults to claude-code opus with orchestrator:true and high effort", () => {
    const args = buildSupervisorArgs({ workspace: "/repo" })
    expect(args.adapter).toBe("claude-code")
    expect(args.model).toBe("claude-opus-4-8")
    expect(args.orchestrator).toBe(true)
    expect(args.effort).toBe("high")
    expect(args.cwd).toBe("/repo")
  })

  it("renders workPackages into spawn prompt", () => {
    const args = buildSupervisorArgs({ workspace: "/repo", workPackages: WPS })
    expect(args.prompt).toContain("WP1")
    expect(args.prompt).toContain("Add auth")
    expect(args.prompt).toContain("Implement JWT middleware")
    expect(args.prompt).toContain("WP2")
    expect(args.prompt).toContain("supervisor agent")
  })

  it("passes custom orchestrator config", () => {
    const orch = { maxDepth: 2, maxChildren: 5 }
    const args = buildSupervisorArgs({ workspace: "/repo", orchestrator: orch })
    expect(args.orchestrator).toEqual(orch)
  })

  it("does not render prompt when workPackages is empty", () => {
    const args = buildSupervisorArgs({ workspace: "/repo", workPackages: [] })
    expect(args.prompt).toBeUndefined()
  })

  it("passes workspaceSlug (no cwd)", () => {
    const args = buildSupervisorArgs({ workspaceSlug: "supervisor-ws" })
    expect(args.workspaceSlug).toBe("supervisor-ws")
    expect(args.cwd).toBeUndefined()
  })

  it("respects model override", () => {
    const args = buildSupervisorArgs({ workspace: "/repo", model: "openai/gpt-4o" })
    expect(args.model).toBe("openai/gpt-4o")
  })
})

describe("createSupervisorHarness", () => {
  it("returns supervisor handle with subtree and waitForAnyChild", async () => {
    const fakeSession = { id: "sess_s", status: "running", startedAt: new Date().toISOString() }
    const client = {
      start: vi.fn().mockResolvedValue(fakeSession),
      sessionTree: vi.fn().mockResolvedValue({ sessionId: "sess_s", tree: [] }),
      waitForAny: vi.fn().mockResolvedValue({ sessionId: "sess_s", event: "turn-end" }),
    } as any
    const handle = await createSupervisorHarness(client, { workspace: "/repo" })
    expect(handle.sessionId).toBe("sess_s")
    expect(handle.adapter).toBe("claude-code")
    expect(typeof handle.subtree).toBe("function")
    expect(typeof handle.waitForAnyChild).toBe("function")
  })

  it("calls client.start with orchestrator:true", async () => {
    const fakeSession = { id: "sess_s2", status: "running", startedAt: new Date().toISOString() }
    const client = {
      start: vi.fn().mockResolvedValue(fakeSession),
      sessionTree: vi.fn().mockResolvedValue({ sessionId: "sess_s2", tree: [] }),
      waitForAny: vi.fn().mockResolvedValue({ sessionId: "sess_s2", event: "turn-end" }),
    } as any
    await createSupervisorHarness(client, { workspace: "/repo" })
    expect(client.start).toHaveBeenCalledOnce()
    expect(client.start.mock.calls[0][0].orchestrator).toBe(true)
  })
})

// ── waitForAnyChild — chunking regression (>20 children) ─────────────────────

describe("waitForAnyChild — chunking path (regression)", () => {
  /**
   * Build a fake sessionTree result with `n` flat child sessions.
   */
  function makeTree(n: number): { tree: Array<{ id: string }> } {
    return {
      tree: Array.from({ length: n }, (_, i) => ({ id: `child_${i}` })),
    }
  }

  it("uses a single waitForAny call when children ≤ 20", async () => {
    const fakeSession = { id: "sess_parent", status: "running", startedAt: new Date().toISOString() }
    const turnResult = { sessionId: "child_0", event: "turn-end" as const }
    const client = {
      start: vi.fn().mockResolvedValue(fakeSession),
      sessionTree: vi.fn().mockResolvedValue(makeTree(20)),
      waitForAny: vi.fn().mockResolvedValue(turnResult),
    } as any

    const handle = await createSupervisorHarness(client, { workspace: "/repo" })
    const result = await handle.waitForAnyChild()

    expect(client.waitForAny).toHaveBeenCalledOnce()
    // All 20 ids passed in one call
    expect(client.waitForAny.mock.calls[0][0]).toHaveLength(20)
    expect(result).toEqual(turnResult)
  })

  it("fans out into chunks of 20 when there are more than 20 children", async () => {
    const fakeSession = { id: "sess_parent", status: "running", startedAt: new Date().toISOString() }
    // 25 children → 2 chunks: 20 + 5
    const turnResult = { sessionId: "child_0", event: "turn-end" as const }
    const client = {
      start: vi.fn().mockResolvedValue(fakeSession),
      sessionTree: vi.fn().mockResolvedValue(makeTree(25)),
      // First call resolves, simulating a turn-end on the first chunk
      waitForAny: vi.fn().mockResolvedValue(turnResult),
    } as any

    const handle = await createSupervisorHarness(client, { workspace: "/repo" })
    const result = await handle.waitForAnyChild({ timeoutMs: 5000 })

    // Two chunks should have been started via Promise.race
    expect(client.waitForAny).toHaveBeenCalledTimes(2)
    const callArgs = client.waitForAny.mock.calls as [string[], { timeoutMs?: number }][]
    const chunkSizes = callArgs.map(([ids]) => ids.length)
    expect(chunkSizes).toContain(20)
    expect(chunkSizes).toContain(5)
    // timeoutMs is forwarded to each chunk
    expect(callArgs[0][1]).toMatchObject({ timeoutMs: 5000 })
    expect(callArgs[1][1]).toMatchObject({ timeoutMs: 5000 })
    expect(result).toEqual(turnResult)
  })

  it("returns 3 chunks for 41 children (20 + 20 + 1)", async () => {
    const fakeSession = { id: "sess_parent", status: "running", startedAt: new Date().toISOString() }
    const turnResult = { sessionId: "child_40", event: "turn-end" as const }
    const client = {
      start: vi.fn().mockResolvedValue(fakeSession),
      sessionTree: vi.fn().mockResolvedValue(makeTree(41)),
      waitForAny: vi.fn().mockResolvedValue(turnResult),
    } as any

    const handle = await createSupervisorHarness(client, { workspace: "/repo" })
    await handle.waitForAnyChild()

    expect(client.waitForAny).toHaveBeenCalledTimes(3)
    const chunkSizes = (client.waitForAny.mock.calls as [string[]][]).map(([ids]) => ids.length)
    expect(chunkSizes).toEqual([20, 20, 1])
  })

  it("returns timeout result when there are no children", async () => {
    const fakeSession = { id: "sess_parent", status: "running", startedAt: new Date().toISOString() }
    const client = {
      start: vi.fn().mockResolvedValue(fakeSession),
      sessionTree: vi.fn().mockResolvedValue({ tree: [] }),
      waitForAny: vi.fn(),
    } as any

    const handle = await createSupervisorHarness(client, { workspace: "/repo" })
    const result = await handle.waitForAnyChild()

    expect(client.waitForAny).not.toHaveBeenCalled()
    expect(result.event).toBe("timeout")
  })
})
