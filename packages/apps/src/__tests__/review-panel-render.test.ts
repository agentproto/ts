import { describe, it, expect } from "vitest"
import {
  ageOf,
  esc,
  laneStatusChip,
  liveSessionUrl,
  renderDetail,
  renderList,
  renderLaneDetail,
  renderRow,
  severityTag,
  shortRange,
  verdictChip,
} from "../review-panel/ui/render.js"
import type { DetailLane, Finding, ReviewRow, RunDetail } from "../review-panel/ui/types.js"

function fakeRow(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return {
    runId: "review-1",
    verdict: "pass",
    binding: "default",
    repoRemote: "github.com/acme/demo",
    baseSha: "b".repeat(40),
    headSha: "h".repeat(40),
    createdAt: "2026-01-01T00:00:00.000Z",
    lanes: [{ id: "ok", status: "pass", blocking: true }],
    ...overrides,
  }
}

function fakeLane(overrides: Partial<DetailLane> = {}): DetailLane {
  return { id: "correctness", kind: "agent", status: "pass", blocking: true, findings: [], ...overrides }
}

describe("esc", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(esc(`<a href="x">&'y'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;'y'&lt;/a&gt;")
  })
})

describe("shortRange", () => {
  it("shortens both shas to 7 chars", () => {
    expect(shortRange("b".repeat(40), "h".repeat(40))).toBe(`${"b".repeat(7)}..${"h".repeat(7)}`)
  })
  it("is an em-dash when either sha is missing (a run whose range isn't resolved yet)", () => {
    expect(shortRange(undefined, "h".repeat(40))).toBe("—")
    expect(shortRange("b".repeat(40), undefined)).toBe("—")
  })
})

describe("ageOf", () => {
  const now = new Date("2026-01-01T01:00:00.000Z").getTime()
  it("renders minutes, hours, and days", () => {
    expect(ageOf("2026-01-01T00:59:30.000Z", now)).toBe("just now")
    expect(ageOf("2026-01-01T00:55:00.000Z", now)).toBe("5m")
    expect(ageOf("2025-12-31T23:00:00.000Z", now)).toBe("2h")
    expect(ageOf("2025-12-29T00:00:00.000Z", now)).toBe("3d")
  })
})

describe("verdictChip / laneStatusChip / severityTag", () => {
  it("renders one chip per verdict/status with a distinct class", () => {
    for (const v of ["pass", "block", "incomplete", "running", "cancelled", "failed"] as const) {
      const html = verdictChip(v)
      expect(html).toContain(`v-${v}`)
      expect(html).toContain(v)
    }
  })
  it("renders one chip per lane status", () => {
    for (const s of ["pass", "fail", "skipped", "timeout"] as const) {
      expect(laneStatusChip(s)).toContain(`l-${s}`)
    }
  })
  it("renders one tag per finding severity", () => {
    for (const s of ["high", "medium", "low"] as const) {
      expect(severityTag(s)).toContain(`sev-${s}`)
    }
  })
})

describe("renderRow / renderList", () => {
  it("renders the empty state for zero rows", () => {
    expect(renderList([])).toContain("No reviews")
  })
  it("a running row shows the running chip and no verdict-derived class collision", () => {
    const row = fakeRow({ status: "running", verdict: undefined })
    const html = renderRow(row)
    expect(html).toContain("v-running")
    expect(html).toContain(`data-runid="review-1"`)
  })
  it("shows dirty/cached flags, requester, and PR state", () => {
    const row = fakeRow({
      dirty: true,
      cached: true,
      requester: { sessionId: "sess_1", gitAuthor: { name: "Ada", email: "ada@example.com" } },
      pr: { provider: "github", repo: "acme/demo", number: 42, url: "https://github.com/acme/demo/pull/42" },
      prState: "open",
    })
    const html = renderRow(row)
    expect(html).toContain("t-dirty")
    expect(html).toContain("t-cached")
    expect(html).toContain("sess_1")
    expect(html).toContain("Ada")
    expect(html).toContain("#42")
    expect(html).toContain("pr-open")
  })
  it("escapes a hostile repoRemote/requester value", () => {
    const row = fakeRow({ repoRemote: `<img src=x onerror=alert(1)>` })
    expect(renderRow(row)).not.toContain("<img")
  })
})

describe("renderLaneDetail", () => {
  it("renders status/blocking/duration for a plain command lane", () => {
    const html = renderLaneDetail(fakeLane({ id: "types", kind: "command", status: "fail", blocking: true, durationMs: 1500, error: "exit 2" }))
    expect(html).toContain("l-fail")
    expect(html).toContain("t-blocking")
    expect(html).toContain("1.5s")
    expect(html).toContain("exit 2")
  })
  it("an advisory lane is tagged advisory, not blocking", () => {
    expect(renderLaneDetail(fakeLane({ blocking: false }))).toContain("t-advisory")
  })
  it("an agent lane shows model, preset, rubric sha, and a reviewer session link", () => {
    const html = renderLaneDetail(
      fakeLane({ sessionId: "sess_reviewer", preset: "kimi", model: "kimi-k2" }),
      [{ check: "correctness", path: "./rubrics/correctness.md", sha256: "a".repeat(64) }],
    )
    expect(html).toContain("kimi-k2")
    expect(html).toContain("kimi")
    expect(html).toContain("a".repeat(12))
    expect(html).toContain('data-session-id="sess_reviewer"')
    expect(html).toContain("sess_reviewer")
  })
  it("renders findings as collapsible details with severity/file:line/title", () => {
    const finding: Finding = { severity: "high", title: "SQL injection", detail: "unsanitized input", file: "db.ts", line: 42 }
    const html = renderLaneDetail(fakeLane({ findings: [finding] }))
    expect(html).toContain("<details")
    expect(html).toContain("sev-high")
    expect(html).toContain("SQL injection")
    expect(html).toContain("db.ts:42")
    expect(html).toContain("unsanitized input")
  })
})

describe("liveSessionUrl", () => {
  it("builds the live-session widget URL with the sessionId query param", () => {
    expect(liveSessionUrl("https://daemon.example", "sess_reviewer")).toBe(
      "https://daemon.example/apps/@agentproto/live-session/ui?sessionId=sess_reviewer",
    )
  })
  it("URL-encodes a sessionId with reserved characters", () => {
    expect(liveSessionUrl("https://daemon.example", "sess/weird id&x")).toBe(
      "https://daemon.example/apps/@agentproto/live-session/ui?sessionId=sess%2Fweird%20id%26x",
    )
  })
})

describe("renderDetail", () => {
  function fakeDetail(overrides: Partial<RunDetail> = {}): RunDetail {
    return { runId: "review-1", status: "done", verdict: "pass", binding: "default", ...overrides }
  }
  it("a done run shows its verdict chip and full lane detail from attestation.lanes", () => {
    const detail = fakeDetail({
      attestation: {
        target: { repoRemote: "r", baseSha: "b", headSha: "h" },
        lanes: [fakeLane()],
        rubrics: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    })
    const html = renderDetail(detail)
    expect(html).toContain("v-pass")
    expect(html).toContain("review-1")
    expect(html).toContain("lane-id")
  })
  it("a running run shows the running chip and the compact lane list", () => {
    const detail = fakeDetail({ status: "running", verdict: undefined, lanes: [{ id: "ok", status: "pass" }] })
    const html = renderDetail(detail)
    expect(html).toContain("v-running")
    expect(html).toContain("ok")
  })
  it("a failed run shows the failed chip and the error", () => {
    const detail = fakeDetail({ status: "failed", verdict: undefined, error: "no REVIEW.md at ..." })
    const html = renderDetail(detail)
    expect(html).toContain("v-failed")
    expect(html).toContain("no REVIEW.md")
  })
  it("a cancelled run shows the cancelled chip", () => {
    const detail = fakeDetail({ status: "cancelled", verdict: undefined })
    expect(renderDetail(detail)).toContain("v-cancelled")
  })
  it("cached is flagged in the header", () => {
    expect(renderDetail(fakeDetail({ cached: true }))).toContain("t-cached")
  })
})
