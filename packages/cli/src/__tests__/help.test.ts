/**
 * `agentproto help <tool>` reads the same `docs/mcp-tools/<tool>.md` files
 * the `tool_help` MCP tool serves (see `@agentproto/runtime`'s `tool-help.ts`)
 * — this test only exercises the CLI's own argv handling and output
 * shaping, not the doc content itself (covered in the runtime package).
 */

import { describe, it, expect, vi, afterEach } from "vitest"

import { runHelp } from "../commands/help.js"

async function capture(args: readonly string[]): Promise<{ out: string; err: string; code: number }> {
  const out: string[] = []
  const err: string[] = []
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    out.push(typeof chunk === "string" ? chunk : String(chunk))
    return true
  }) as typeof process.stdout.write)
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    err.push(typeof chunk === "string" ? chunk : String(chunk))
    return true
  }) as typeof process.stderr.write)
  try {
    const code = await runHelp(args)
    return { out: out.join(""), err: err.join(""), code }
  } finally {
    outSpy.mockRestore()
    errSpy.mockRestore()
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("runHelp", () => {
  it("prints the full agent_start doc", async () => {
    const { out, code } = await capture(["agent_start"])
    expect(code).toBe(0)
    expect(out).toContain("agent_start")
    expect(out).toContain("## worktree")
  })

  it("--topic prints just that section", async () => {
    const { out, code } = await capture(["agent_start", "--topic", "worktree"])
    expect(code).toBe(0)
    expect(out).toContain("## worktree")
    expect(out).not.toContain("## sandbox")
  })

  it("errors with a topic list for an unknown tool", async () => {
    const { err, code } = await capture(["not_a_real_tool"])
    expect(code).toBe(1)
    expect(err).toContain("not_a_real_tool")
  })

  it("with no args prints usage", async () => {
    const { out, code } = await capture([])
    expect(code).toBe(0)
    expect(out).toContain("agentproto help <tool>")
  })
})
