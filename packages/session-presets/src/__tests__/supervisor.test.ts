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

describe("SupervisorHandle.waitForAnyChild — chunking", () => {
  it("handles >20 children by chunking into groups of 20", async () => {
    const fakeSession = { id: "sess_sup", status: "running", startedAt: new Date().toISOString() }
    const turnResult = { sessionId: "sess_child_0", event: "turn-end" as const }
    // 25 children — exceeds the 20-child cap
    const tree = Array.from({ length: 25 }, (_, i) => ({ id: `sess_child_${i}` }))
    const client = {
      start: vi.fn().mockResolvedValue(fakeSession),
      sessionTree: vi.fn().mockResolvedValue({ sessionId: "sess_sup", tree }),
      waitForAny: vi.fn().mockResolvedValue(turnResult),
    } as any
    const handle = await createSupervisorHarness(client, { workspace: "/repo" })
    const result = await handle.waitForAnyChild()
    // waitForAny should have been called twice (chunks of 20 + 5)
    expect(client.waitForAny).toHaveBeenCalledTimes(2)
    expect(result).toEqual(turnResult)
  })
})