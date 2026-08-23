import { describe, it, expect } from "vitest"
import { mastracode } from "../index.js"

describe("mastracode adapter manifest", () => {
  it("uses the CLI's real --output jsonl flag, not the nonexistent stream-json format", () => {
    expect(mastracode.print?.output_format).toEqual(["--output", "jsonl"])
  })

  it("declares resumable: true — `--thread <id>` genuinely rehydrates a prior thread", () => {
    expect(mastracode.capabilities?.resumable).toBe(true)
  })

  it("advertises native-resume as a supported continuation strategy", () => {
    expect(mastracode.continuation?.supported).toContain("native-resume")
  })

  it("keeps the --thread resume flag wired for the print arm", () => {
    expect(mastracode.print?.resume).toEqual({ flag: "--thread", kind: "value" })
  })

  it("declares the external anthropic-scoped subscription (mastracode's own Claude Pro/Max login)", () => {
    // External: the runtime injects no bearer (an agentproto-held OAT on
    // mastracode's x-api-key channel is rejected upstream) — it verifies the
    // CLI's own /login (auth.json `anthropic` oauth entry) is present and
    // scrubs api-key vars so a leftover key can't override it.
    expect(mastracode.authSubscription).toEqual({
      external: true,
      provider: "anthropic",
    })
  })
})
