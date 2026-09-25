import { describe, it, expect, vi } from "vitest"
import { runBranch, parseScopes } from "../commands/branch.js"

describe("agentproto branch", () => {
  it("parseScopes validates kinds", () => {
    expect(parseScopes(undefined)).toBeUndefined()
    expect(parseScopes("local, orphan")).toEqual(["local", "orphan"])
    expect(() => parseScopes("local,tags")).toThrow(/unknown scope "tags"/)
  })

  it("--apply without --scopes is refused before anything runs", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      expect(await runBranch(["gc", "--apply", "--repo", process.cwd()])).toBe(2)
      expect(err.mock.calls.map(c => String(c[0])).join("")).toContain("--apply requires --scopes")
    } finally {
      err.mockRestore()
    }
  })

  it("prints usage and rejects unknown subcommands", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      expect(await runBranch(["--help"])).toBe(0)
      expect(out.mock.calls.map(c => String(c[0])).join("")).toContain("review-queue")
      expect(await runBranch(["prune"])).toBe(2)
    } finally {
      out.mockRestore()
      err.mockRestore()
    }
  })
})
