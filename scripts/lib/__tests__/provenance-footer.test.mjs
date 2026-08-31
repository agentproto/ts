import { describe, it, expect } from "vitest"
import { buildFooter, MARKER } from "../provenance-footer.mjs"

describe("buildFooter", () => {
  const baseProv = {
    sessionId: "sess_abc123",
    label: "fix-foo",
    adapter: "claude-code",
    model: "kimi-k2.7-code",
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
        "claude-code / subscription · model `kimi-k2.7-code` · 12.3k in / 67.9k out · $0.1234 · " +
        "run [123456789](https://github.com/agentproto/ts/actions/runs/123456789) · " +
        "sha `abcdef1234567890`</sub>",
    )
  })

  it("local shape renders host/cwd + cost and omits the run link", () => {
    const footer = buildFooter({
      prov: {
        ...baseProv,
        source: "local",
        host: "jeremy-mac-studio",
        cwd: "/Volumes/SSDExternalMacStudio/Code/_agentproto-worktrees/ts/local-pr-provenance-audit",
        workspaceSlug: "ts",
      },
      authMode: "subscription",
      sha: "abcdef1234567890",
      kind: "PR",
    })
    expect(footer).toBe(
      "\n\n---\n" +
        "<sub>🤖 **@agentproto-bot** — PR · session `sess_abc123` (`fix-foo`) · " +
        "claude-code / subscription · model `kimi-k2.7-code` · 12.3k in / 67.9k out · $0.1234 (local) · " +
        "host `jeremy-mac-studio` · cwd `ts/local-pr-provenance-audit` · " +
        "sha `abcdef1234567890`</sub>",
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
        "claude-code / subscription · model `kimi-k2.7-code` · 12.3k in / 67.9k out · $0.1234 (local) · " +
        "sha `abcdef1234567890`</sub>",
    )
  })

  it("exposes the deterministic marker", () => {
    expect(MARKER).toBe("@agentproto-bot")
  })

  it("maps raw SessionRef field names and renders session/adapter/model without legacy fallback", () => {
    // computeProvenance returns `id`, `adapterSlug`, and `model`; buildFooter
    // consumes `sessionId`, `adapter`, and `model`. This test guards the seam.
    const rawSessionRef = {
      id: "sess_raw456",
      label: "raw-label",
      adapterSlug: "claude-sdk",
      model: "kimi-k2.7-code",
      tokensIn: 1000,
      tokensOut: 2000,
      costUsd: 0.0567,
    }
    const mapped = {
      sessionId: rawSessionRef.id,
      label: rawSessionRef.label,
      adapter: rawSessionRef.adapterSlug,
      model: rawSessionRef.model,
      costUsd: rawSessionRef.costUsd,
      tokensIn: rawSessionRef.tokensIn,
      tokensOut: rawSessionRef.tokensOut,
      source: "local",
    }
    const footer = buildFooter({
      prov: mapped,
      authMode: "subscription",
      sha: "505cbca1234567890",
      kind: "PR",
    })
    expect(footer).toContain("session `sess_raw456` (`raw-label`)")
    expect(footer).toContain("claude-sdk / subscription")
    expect(footer).toContain("model `kimi-k2.7-code`")
    expect(footer).not.toContain("legacy fallback")
  })
})
