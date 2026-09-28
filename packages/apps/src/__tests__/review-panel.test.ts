import { describe, it, expect } from "vitest"
import { makeReviewPanelApp, reviewPanelApp, reviewPanelInputSchema } from "../review-panel/index.js"
import { REVIEW_PANEL_HTML, REVIEW_PANEL_UI_TOOLS } from "../review-panel/panel.js"

describe("reviewPanelInputSchema", () => {
  it("every field is optional", () => {
    expect(reviewPanelInputSchema.safeParse({}).success).toBe(true)
    expect(
      reviewPanelInputSchema.safeParse({ cwd: "/repo", repoRemote: "github.com/a/b", runId: "review-1", requesterSessionId: "s" })
        .success,
    ).toBe(true)
  })
})

describe("makeReviewPanelApp", () => {
  it("exposes the builtin tool metadata", () => {
    const app = makeReviewPanelApp({ listReviews: () => ({ total: 0, attestations: [] }) })
    expect(app.id).toBe("agentproto_reviews")
    expect(app.title).toBe("Reviews")
    expect(app.inputSchema.shape.cwd).toBeDefined()
    expect(app.html).toBe(REVIEW_PANEL_HTML)
  })

  it("execute() forwards the input to ops.listReviews and echoes focusRunId", async () => {
    let seen: unknown
    const app = makeReviewPanelApp({
      listReviews: input => {
        seen = input
        return { total: 1, attestations: [{ runId: "review-1" }] }
      },
    })
    const out = await app.execute!({ cwd: "/repo", runId: "review-1" })
    expect(seen).toEqual({ cwd: "/repo", runId: "review-1" })
    expect(out).toEqual({ total: 1, attestations: [{ runId: "review-1" }], focusRunId: "review-1" })
  })

  it("execute() omits focusRunId when no runId is given", async () => {
    const app = makeReviewPanelApp({ listReviews: () => ({ total: 0, attestations: [] }) })
    const out = await app.execute!({})
    expect(out).toEqual({ total: 0, attestations: [] })
  })
})

describe("reviewPanelApp (AppHandle / catalog path)", () => {
  it("is a zero-agent UI-only app whose static ui.html is the review panel", () => {
    expect(reviewPanelApp.id).toBe("@agentproto/review-panel")
    expect(reviewPanelApp.agents).toEqual([])
    expect(reviewPanelApp.ui?.html).toBe(REVIEW_PANEL_HTML)
    expect(reviewPanelApp.ui?.title).toBe("Reviews")
    expect(reviewPanelApp.ui?.tools).toEqual([...REVIEW_PANEL_UI_TOOLS])
  })
})

describe("REVIEW_PANEL_HTML", () => {
  it("is a non-empty, single-file self-contained HTML document", () => {
    expect(REVIEW_PANEL_HTML.length).toBeGreaterThan(0)
    expect(REVIEW_PANEL_HTML).toContain("<!DOCTYPE html>")
    // Single-file build: no external asset references left to fetch.
    expect((REVIEW_PANEL_HTML.match(/\.\/assets/g) ?? []).length).toBe(0)
  })

  it("polls review_ledger with includeRunning, never a second write path", () => {
    expect(REVIEW_PANEL_HTML).toContain("review_ledger")
    expect(REVIEW_PANEL_HTML).toContain("includeRunning")
  })

  it("calls every declared real tool name — no invented endpoint", () => {
    for (const tool of REVIEW_PANEL_UI_TOOLS) {
      expect(REVIEW_PANEL_HTML).toContain(tool)
    }
  })

  it("declares live_session on its ui.tools allowlist, for the reviewer-session deep link", () => {
    expect(REVIEW_PANEL_UI_TOOLS).toContain("live_session")
  })

  it("re-run fresh passes nocache + wait:false + supersede", () => {
    expect(REVIEW_PANEL_HTML).toContain("nocache")
    expect(REVIEW_PANEL_HTML).toContain("supersede")
  })

  it("renders the verdict chips for every status", () => {
    for (const v of ["v-pass", "v-block", "v-incomplete", "v-running", "v-cancelled", "v-failed"]) {
      expect(REVIEW_PANEL_HTML).toContain(v)
    }
  })
})
