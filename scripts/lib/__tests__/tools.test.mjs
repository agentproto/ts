import { describe, it, expect } from "vitest"
import { sessionRefToProv } from "../tools.mjs"

describe("sessionRefToProv", () => {
  it("maps a computeProvenance SessionRef to the buildFooter-expected shape", () => {
    const primary = {
      id: "sess_claude789",
      label: "footer-smoketest",
      adapterSlug: "claude-sdk",
      model: "kimi-k2.7-code",
      costUsd: 0.1234,
      tokensIn: 1234,
      tokensOut: 5678,
      authMode: "subscription",
      cwd: "/Volumes/SSDExternalMacStudio/Code/_agentproto-worktrees/ts/footer-smoketest",
      status: "closed",
      startedAt: "2026-07-20T12:00:00Z",
    }
    expect(sessionRefToProv(primary)).toEqual({
      sessionId: "sess_claude789",
      label: "footer-smoketest",
      adapter: "claude-sdk",
      model: "kimi-k2.7-code",
      costUsd: 0.1234,
      tokensIn: 1234,
      tokensOut: 5678,
      source: "local",
    })
  })
})
