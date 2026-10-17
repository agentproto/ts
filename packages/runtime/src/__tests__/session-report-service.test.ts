/**
 * Focused coverage for `collectSessionReportInputs`/`buildSessionReportFromRegistry`
 * — the impure registry collection shared by the `sessions_report` MCP tool and
 * `GET /sessions/report`. The pure reducer math is owned by session-report.test.ts;
 * here we only assert the collection contract: kind filtering, the onlyIds subtree
 * filter, and the live-vs-cold field projection.
 *
 * `transcriptBaseDir` points at a directory that doesn't exist, so the cold-disk
 * side of the merge always resolves to `[]` — only the live registry is exercised.
 */
import { describe, expect, it, beforeEach } from "vitest"
import type { SessionDescriptor, SessionsRegistry } from "../sessions.js"
import { resetColdSessionCache } from "../session-cold-list.js"
import { collectSessionReportInputs, buildSessionReportFromRegistry } from "../session-report-service.js"

const NO_COLD_DIR = "/nonexistent-dir-for-session-report-service-test"

function fakeRegistry(descriptors: Partial<SessionDescriptor>[]): SessionsRegistry {
  return {
    list: () => descriptors as SessionDescriptor[],
    transcriptBaseDir: NO_COLD_DIR,
  } as unknown as SessionsRegistry
}

beforeEach(() => {
  resetColdSessionCache()
})

describe("collectSessionReportInputs", () => {
  it("keeps only agent-cli sessions", () => {
    const registry = fakeRegistry([
      { id: "a", kind: "agent-cli", status: "exited", startedAt: "2026-07-24T00:00:00.000Z" },
      { id: "t", kind: "terminal", status: "exited", startedAt: "2026-07-24T00:00:00.000Z" },
      { id: "c", kind: "command", status: "exited", startedAt: "2026-07-24T00:00:00.000Z" },
    ])
    const out = collectSessionReportInputs(registry)
    expect(out.map(s => s.id)).toEqual(["a"])
  })

  it("onlyIds restricts to the given subtree", () => {
    const registry = fakeRegistry([
      { id: "a", kind: "agent-cli", status: "exited", startedAt: "2026-07-24T00:00:00.000Z" },
      { id: "b", kind: "agent-cli", status: "exited", startedAt: "2026-07-24T00:00:00.000Z" },
    ])
    const out = collectSessionReportInputs(registry, { onlyIds: new Set(["b"]) })
    expect(out.map(s => s.id)).toEqual(["b"])
  })

  it("projects harness (falling back to adapterSlug), auth mode and PRs off the descriptor", () => {
    const registry = fakeRegistry([
      {
        id: "a",
        kind: "agent-cli",
        status: "exited",
        startedAt: "2026-07-24T00:00:00.000Z",
        adapterSlug: "claude-code",
        model: "sonnet",
        costUsd: 1.5,
        tokensIn: 100,
        tokensOut: 50,
        usageSource: "adapter",
        auth: { mode: "subscription", fingerprint: "subscription · sk-ant…abcd" },
        keepAlive: true,
        openedPrs: [{ adapter: "github", number: 7, url: "https://x/pull/7", openedAt: "2026-07-24T00:00:00.000Z" }],
      },
    ])
    const [row] = collectSessionReportInputs(registry)
    expect(row).toMatchObject({
      id: "a",
      harness: "claude-code",
      model: "sonnet",
      costUsd: 1.5,
      tokensIn: 100,
      tokensOut: 50,
      authMode: "subscription",
      keepAlive: true,
      openedPrs: [{ adapter: "github", number: 7, url: "https://x/pull/7", openedAt: "2026-07-24T00:00:00.000Z" }],
    })
  })

  it("harness wins over adapterSlug when both are present", () => {
    const registry = fakeRegistry([
      { id: "a", kind: "agent-cli", status: "exited", startedAt: "2026-07-24T00:00:00.000Z", harness: "claude-code", adapterSlug: "legacy-slug" },
    ])
    const [row] = collectSessionReportInputs(registry)
    expect(row!.harness).toBe("claude-code")
  })
})

describe("buildSessionReportFromRegistry", () => {
  it("collects then reduces in one call", () => {
    const registry = fakeRegistry([
      { id: "a", kind: "agent-cli", status: "exited", startedAt: "2026-07-24T06:00:00.000Z", harness: "claude-code" },
      { id: "b", kind: "agent-cli", status: "exited", startedAt: "2026-07-20T00:00:00.000Z", harness: "claude-code" },
    ])
    const report = buildSessionReportFromRegistry(registry, {
      since: "5h",
      nowMs: Date.parse("2026-07-24T07:00:00.000Z"),
    })
    expect(report.totalSessions).toBe(1)
    expect(report.byHarness).toEqual([{ key: "claude-code", count: 1 }])
  })
})
