/**
 * Tests for `agentproto onboard` — driven through the public `runOnboard`
 * entrypoint, plus unit tests on the `onboardFlow` primitive.
 *
 * Uses injected fake `OnboardDeps` that record calls and return canned
 * exit codes — NO real installs. Mirrors install-mcp.test.ts style.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runOnboard, onboardFlow } from "../commands/onboard.js"
import type { OnboardDeps, OnboardOptions } from "../commands/onboard.js"

// ── helpers ─────────────────────────────────────────────────────────────

interface FakeDeps extends OnboardDeps {
  /** All recorded calls to installMcp. */
  mcpCalls: readonly string[][]
  /** All recorded calls to installSkill. */
  skillCalls: { slug: string; args: readonly string[] }[]
  /** Canned exit code returned by installMcp. */
  setMcpCode: (code: number) => void
  /** Canned exit code returned by installSkill. */
  setSkillCode: (code: number) => void
}

function createFakeDeps(): FakeDeps {
  const mcpCalls: string[][] = []
  const skillCalls: { slug: string; args: readonly string[] }[] = []
  let mcpCode = 0
  let skillCode = 0
  return {
    mcpCalls,
    skillCalls,
    installMcp: vi.fn(async (args: readonly string[]): Promise<number> => {
      mcpCalls.push([...args])
      return mcpCode
    }),
    installSkill: vi.fn(async (slug: string, args: readonly string[]): Promise<number> => {
      skillCalls.push({ slug, args })
      return skillCode
    }),
    setMcpCode: (c: number) => {
      mcpCode = c
    },
    setSkillCode: (c: number) => {
      skillCode = c
    },
  }
}

/** Silence stdout for the duration of a test. */
function captureStdout(): { restore: () => void } {
  const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true)
  return { restore: () => spy.mockRestore() }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── tests: runOnboard ───────────────────────────────────────────────────

describe("runOnboard default", () => {
  it("calls installMcp with --all and installSkill with default pack", async () => {
    const { restore } = captureStdout()
    const deps = createFakeDeps()

    const code = await runOnboard([], deps)
    restore()

    expect(code).toBe(0)
    expect(deps.mcpCalls).toHaveLength(1)
    expect(deps.mcpCalls[0]).toEqual(["--all"])
    expect(deps.skillCalls).toHaveLength(1)
    expect(deps.skillCalls[0]!.slug).toBe("skill/agentproto-pack")
    expect(deps.skillCalls[0]!.args).toEqual([])
  })
})

describe("runOnboard --no-skills", () => {
  it("skips installSkill, still calls installMcp", async () => {
    const { restore } = captureStdout()
    const deps = createFakeDeps()

    const code = await runOnboard(["--no-skills"], deps)
    restore()

    expect(code).toBe(0)
    expect(deps.mcpCalls).toHaveLength(1)
    expect(deps.mcpCalls[0]).toEqual(["--all"])
    expect(deps.skillCalls).toHaveLength(0)
  })
})

describe("runOnboard --yes", () => {
  it("passes --yes through to installMcp", async () => {
    const { restore } = captureStdout()
    const deps = createFakeDeps()

    const code = await runOnboard(["--yes"], deps)
    restore()

    expect(code).toBe(0)
    expect(deps.mcpCalls).toHaveLength(1)
    expect(deps.mcpCalls[0]).toEqual(["--all", "--yes"])
  })
})

describe("runOnboard --agent", () => {
  it("passes each --agent to installMcp, no --all", async () => {
    const { restore } = captureStdout()
    const deps = createFakeDeps()

    const code = await runOnboard(["--agent", "claude-code", "--agent", "hermes"], deps)
    restore()

    expect(code).toBe(0)
    expect(deps.mcpCalls).toHaveLength(1)
    expect(deps.mcpCalls[0]).toEqual(["--agent", "claude-code", "--agent", "hermes"])
  })
})

describe("runOnboard --skills <name>", () => {
  it("prefixes bare slug with skill/", async () => {
    const { restore } = captureStdout()
    const deps = createFakeDeps()

    const code = await runOnboard(["--skills", "nested-orchestration"], deps)
    restore()

    expect(code).toBe(0)
    expect(deps.skillCalls).toHaveLength(1)
    expect(deps.skillCalls[0]!.slug).toBe("skill/nested-orchestration")
    expect(deps.skillCalls[0]!.args).toEqual([])
  })
})

describe("runOnboard --skills skill/<name>", () => {
  it("passes already-prefixed slug through unchanged", async () => {
    const { restore } = captureStdout()
    const deps = createFakeDeps()

    const code = await runOnboard(["--skills", "skill/nested-orchestration"], deps)
    restore()

    expect(code).toBe(0)
    expect(deps.skillCalls).toHaveLength(1)
    expect(deps.skillCalls[0]!.slug).toBe("skill/nested-orchestration")
    expect(deps.skillCalls[0]!.args).toEqual([])
  })
})

describe("runOnboard exit code", () => {
  it("mcp failure dominates, but installSkill still called", async () => {
    const { restore } = captureStdout()
    const deps = createFakeDeps()
    deps.setMcpCode(3)
    deps.setSkillCode(0)

    const code = await runOnboard([], deps)
    restore()

    expect(code).toBe(3)
    expect(deps.mcpCalls).toHaveLength(1)
    // Skill step is independent — still called even when MCP fails
    expect(deps.skillCalls).toHaveLength(1)
  })
})

// ── tests: onboardFlow primitive ────────────────────────────────────────

describe("onboardFlow --no-skills report", () => {
  it("returns mcpCode: 0, skillCode: null when skills are disabled", async () => {
    const { restore } = captureStdout()
    const deps = createFakeDeps()

    const opts: OnboardOptions = {
      yes: false,
      skills: false,
      skillSlug: "x",
      agents: [],
    }
    const report = await onboardFlow(opts, deps)
    restore()

    expect(report.mcpCode).toBe(0)
    expect(report.skillCode).toBeNull()
    expect(deps.skillCalls).toHaveLength(0)
  })
})
