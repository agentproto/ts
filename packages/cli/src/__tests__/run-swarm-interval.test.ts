/**
 * `agentproto run-swarm --interval <duration>` — validation of the shared
 * duration parser wired into run-swarm.ts. `--interval` used to silently
 * fall back to the 2000ms default on ANY unparseable value (missing suffix
 * support beyond `s`, no error message at all) — these pin the fix: an
 * invalid value is now a loud, fast usage error (exit 2, before the
 * manifest is ever touched), not a silent no-op.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runRunSwarm } from "../commands/run-swarm.js"

describe("agentproto run-swarm --interval", () => {
  let stderrChunks: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any

  beforeEach(() => {
    stderrChunks = []
    stderrSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(process.stderr as any, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(String(chunk))
        return true
      })
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    vi.resetAllMocks()
  })

  it("rejects a bare number under 1000 as an ambiguous units slip, before touching the manifest", async () => {
    const code = await runRunSwarm(["--manifest", "does-not-exist.yaml", "--interval", "30"])
    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain("--interval 30")
    expect(stderrChunks.join("")).toContain("almost certainly not what you meant")
  })

  it("rejects an unknown suffix instead of silently falling back to the 2000ms default", async () => {
    const code = await runRunSwarm(["--manifest", "does-not-exist.yaml", "--interval", "30x"])
    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain('invalid --interval "30x"')
  })

  it("rejects 0", async () => {
    const code = await runRunSwarm(["--manifest", "does-not-exist.yaml", "--interval", "0"])
    expect(code).toBe(2)
  })
})
