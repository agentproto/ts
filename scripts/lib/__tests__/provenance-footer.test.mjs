import { describe, it, expect } from "vitest"
import { buildFooter, MARKER } from "../provenance-footer.mjs"

describe("buildFooter", () => {
  const baseProv = {
    sessionId: "sess_abc123",
    label: "fix-foo",
    adapter: "claude-code",
    tokensIn: 12345,
    tokensOut: 67890,
    costUsd: 0.1234,
  }

  it("CI shape is byte-identical to the existing render (run link, no host/cwd)", () => {
    const footer = buildFooter({
      prov: { ...baseProv, source: "adapter" },
      authMode: "subscription",
      runId: "123456789",
      runUrl: "https://github.com/agentproto/ts/actions/runs/123456789",
      sha: "abcdef1234567890",
      kind: "PR",
    })
    expect(footer).toBe(
      "\n\n---\n" +
        "<sub>🤖 **@agentproto-bot** — PR · session `sess_abc123` (`fix-foo`) · " +
        "claude-code / subscription · 12.3k in / 67.9k out · $0.1234 · " +
        "run [123456789](https://github.com/agentproto/ts/actions/runs/123456789) · " +
        "sha `abcdef1`</sub>",
    )
  })

  it("local shape renders host/cwd + cost and omits the run link", () => {
    const footer = buildFooter({
      prov: {
        ...baseProv,
        source: "local",
        host: "jeremy-mac-studio",
        cwd: "/Volumes/SSDExternalMacStudio/Code/_agentproto-worktrees/ts/local-pr-provenance-audit",
      },
      authMode: "subscription",
      sha: "abcdef1234567890",
      kind: "PR",
    })
    expect(footer).toBe(
      "\n\n---\n" +
        "<sub>🤖 **@agentproto-bot** — PR · session `sess_abc123` (`fix-foo`) · " +
        "claude-code / subscription · 12.3k in / 67.9k out · $0.1234 (local) · " +
        "host `jeremy-mac-studio` · cwd `local-pr-provenance-audit` · " +
        "sha `abcdef1`</sub>",
    )
  })

  it("local shape without host/cwd (e.g. AGENTFLOW_FOOTER_HOST=0) still stamps the rest", () => {
    const footer = buildFooter({
      prov: { ...baseProv, source: "local" },
      authMode: "subscription",
      sha: "abcdef1234567890",
      kind: "PR",
    })
    expect(footer).toBe(
      "\n\n---\n" +
        "<sub>🤖 **@agentproto-bot** — PR · session `sess_abc123` (`fix-foo`) · " +
        "claude-code / subscription · 12.3k in / 67.9k out · $0.1234 (local) · " +
        "sha `abcdef1`</sub>",
    )
  })

  it("exposes the deterministic marker", () => {
    expect(MARKER).toBe("@agentproto-bot")
  })
})
