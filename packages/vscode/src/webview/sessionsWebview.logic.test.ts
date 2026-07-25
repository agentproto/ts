import { describe, expect, it } from "vitest"

import type { SessionDescriptor, WorkspacesConfig } from "../client/types.js"
import {
  buildSessionsWebviewModel,
  formatCost,
  harnessGlyphFor,
  HARNESS_GLYPHS,
  HARNESS_GLYPH_FALLBACK,
  summaryTextFor,
  webviewRowStatus,
  type WebviewRow,
} from "./sessionsWebview.logic.js"

function session(over: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "s1",
    kind: "agent-cli",
    workspaceSlug: "ws",
    command: "claude-code --print",
    pid: 123,
    status: "running",
    startedAt: "2026-01-01T00:00:00Z",
    ...over,
  }
}

const config: WorkspacesConfig = {
  version: 1,
  workspaces: [{ slug: "studio", path: "/Code/studio", addedAt: "", updatedAt: "", label: "Agentik Studio" }],
}

const NOW = Date.parse("2026-01-02T00:00:00Z")

describe("harnessGlyphFor", () => {
  it("maps every locked harness to its glyph", () => {
    expect(harnessGlyphFor("claude-code")).toBe("✳")
    expect(harnessGlyphFor("hermes")).toBe("☿")
    expect(harnessGlyphFor("codex")).toBe("◈")
    expect(harnessGlyphFor("gemini-cli")).toBe("✦")
  })
  it("falls back to • for an unrecognized or absent slug", () => {
    expect(harnessGlyphFor("some-future-harness")).toBe(HARNESS_GLYPH_FALLBACK)
    expect(harnessGlyphFor(undefined)).toBe(HARNESS_GLYPH_FALLBACK)
  })
  it("HARNESS_GLYPHS carries exactly the four locked entries", () => {
    expect(Object.keys(HARNESS_GLYPHS).sort()).toEqual(["claude-code", "codex", "gemini-cli", "hermes"])
  })
})

describe("formatCost", () => {
  it("formats a positive cost to two decimals with a leading $", () => {
    expect(formatCost(1.2449)).toBe("$1.24")
    expect(formatCost(0.9)).toBe("$0.90")
  })
  it("renders nothing for zero, negative, or missing cost", () => {
    expect(formatCost(0)).toBeUndefined()
    expect(formatCost(-1)).toBeUndefined()
    expect(formatCost(undefined)).toBeUndefined()
  })
})

describe("webviewRowStatus", () => {
  it("folds needs-you into awaiting", () => {
    expect(webviewRowStatus(session({ awaitingInput: true }))).toBe("awaiting")
  })
  it("folds working/idle/stalled into live", () => {
    expect(webviewRowStatus(session({ busy: true }))).toBe("live")
    expect(webviewRowStatus(session({ busy: false }))).toBe("live")
  })
  it("folds done/stopped/failed into done", () => {
    expect(webviewRowStatus(session({ status: "exited" }))).toBe("done")
    expect(webviewRowStatus(session({ status: "killed", killedMidTurn: true }))).toBe("done")
    expect(webviewRowStatus(session({ status: "error" }))).toBe("done")
  })
})

describe("buildSessionsWebviewModel", () => {
  it("groups by workspace with a count badge, split into recent/older", () => {
    const sessions = [
      session({ id: "a", cwd: "/Code/studio", startedAt: "2026-01-01T23:00:00Z" }), // recent (1h before NOW)
      session({ id: "b", cwd: "/Code/studio", startedAt: "2025-12-01T00:00:00Z" }), // older
    ]
    const model = buildSessionsWebviewModel(sessions, config, [], { tab: "all", search: "", now: NOW })
    expect(model.groups).toHaveLength(1)
    const group = model.groups[0]!
    expect(group.name).toBe("Agentik Studio")
    expect(group.count).toBe(2)
    expect(group.section.recent.map(r => r.id)).toEqual(["a"])
    expect(group.section.older.map(r => r.id)).toEqual(["b"])
    expect(model.shownCount).toBe(2)
    expect(model.totalCount).toBe(2)
  })

  it("flattens parentSessionId children under their root as isSub rows, in the root's own section", () => {
    const sessions = [
      session({ id: "root", cwd: "/Code/studio", startedAt: "2026-01-01T23:00:00Z" }),
      session({ id: "child", cwd: "/Code/studio", parentSessionId: "root", startedAt: "2025-01-01T00:00:00Z" }),
    ]
    const model = buildSessionsWebviewModel(sessions, config, [], { tab: "all", search: "", now: NOW })
    const rows = model.groups[0]!.section.recent
    expect(rows.map(r => r.id)).toEqual(["root", "child"])
    expect(rows.find(r => r.id === "root")?.isSub).toBe(false)
    expect(rows.find(r => r.id === "child")?.isSub).toBe(true)
    // A child never migrates to "older" on its own startedAt — it rides with its root.
    expect(model.groups[0]!.section.older).toHaveLength(0)
  })

  it("maps a row's fields from the reused pure helpers", () => {
    const sessions = [
      session({
        id: "a",
        cwd: "/Code/studio",
        adapterSlug: "hermes",
        model: "glm-5.2",
        costUsd: 0.42,
        contextUsed: 33,
        contextSize: 100,
        label: "exec · canvakit-extract",
      }),
    ]
    const model = buildSessionsWebviewModel(sessions, config, [], { tab: "all", search: "", now: NOW })
    const row = model.groups[0]!.section.recent[0]! as WebviewRow
    expect(row.name).toBe("exec · canvakit-extract")
    expect(row.harnessGlyph).toBe("☿")
    expect(row.model).toBe("glm-5.2")
    expect(row.cost).toBe("$0.42")
    expect(row.ctxPercent).toBe(33)
    expect(row.tag).toBe("in-place")
  })

  it("filters by tab, folding stopped/failed into done", () => {
    const sessions = [
      session({ id: "live", cwd: "/Code/studio", busy: true }),
      session({ id: "await", cwd: "/Code/studio", awaitingInput: true }),
      session({ id: "done", cwd: "/Code/studio", status: "exited" }),
      session({ id: "failed", cwd: "/Code/studio", status: "error" }),
    ]
    const liveModel = buildSessionsWebviewModel(sessions, config, [], { tab: "live", search: "", now: NOW })
    expect(liveModel.shownCount).toBe(1)
    const doneModel = buildSessionsWebviewModel(sessions, config, [], { tab: "done", search: "", now: NOW })
    expect(doneModel.shownCount).toBe(2)
  })

  it("filters by the pinned search input via the reused predicate", () => {
    const sessions = [
      session({ id: "a", cwd: "/Code/studio", label: "sales-analysis" }),
      session({ id: "b", cwd: "/Code/studio", label: "unrelated" }),
    ]
    const model = buildSessionsWebviewModel(sessions, config, [], { tab: "all", search: "sales", now: NOW })
    expect(model.shownCount).toBe(1)
    expect(model.groups[0]!.section.recent[0]!.id).toBe("a")
  })

  it("drops the create-workspace CTA row — no equivalent affordance in the webview", () => {
    const sessions = [session({ id: "a", cwd: "/Code/elsewhere" })]
    const model = buildSessionsWebviewModel(sessions, config, ["/Code/elsewhere"], {
      tab: "all",
      search: "",
      now: NOW,
    })
    // "elsewhere" matches no registered workspace but IS an open folder, so the
    // tree would offer a "Create workspace here" CTA — the webview must not.
    expect(model.groups.every(g => g.name !== undefined)).toBe(true)
    expect(model.groups.some(g => g.section.recent.some(r => r.id === "a") || g.section.older.some(r => r.id === "a"))).toBe(
      true,
    )
  })
})

describe("summaryTextFor", () => {
  it("reports shown-of-total only while a filter is active", () => {
    const model = { groups: [], shownCount: 3, totalCount: 10 }
    expect(summaryTextFor(model, true)).toBe("3 of 10 shown")
    expect(summaryTextFor(model, false)).toBe("10 loaded")
  })
})
