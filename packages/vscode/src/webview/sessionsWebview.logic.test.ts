import { describe, expect, it } from "vitest"

import type { SessionSummary, WorkspacesConfig } from "../client/types.js"
import {
  buildSessionsWebviewModel,
  formatCost,
  harnessGlyphFor,
  HARNESS_GLYPHS,
  HARNESS_GLYPH_FALLBACK,
  relativeLuminance,
  rowActionFor,
  summaryTextFor,
  webviewRowStatus,
  WORKSPACE_PALETTE,
  workspaceColorFor,
  type WebviewRow,
} from "./sessionsWebview.logic.js"

function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "s1",
    kind: "agent-cli",
    workspaceSlug: "ws",
    command: "claude-code --print",
    pid: 123,
    status: "running",
    startedAt: "2026-01-01T23:00:00Z",
    ...over,
  }
}

const studioConfig: WorkspacesConfig = {
  version: 1,
  workspaces: [{ slug: "studio", path: "/Code/studio", addedAt: "", updatedAt: "", label: "Agentik Studio" }],
}

const multiConfig: WorkspacesConfig = {
  version: 1,
  workspaces: [
    { slug: "studio", path: "/Code/studio", addedAt: "", updatedAt: "", label: "Agentik Studio" },
    { slug: "other", path: "/Code/other", addedAt: "", updatedAt: "", label: "Other Project" },
  ],
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
  it("maps each tree activity to its own row status", () => {
    expect(webviewRowStatus(session({ awaitingInput: true }))).toBe("awaiting")
    expect(webviewRowStatus(session({ status: "starting" }))).toBe("working")
    expect(webviewRowStatus(session({ busy: true }))).toBe("working")
    expect(webviewRowStatus(session({ busy: false }))).toBe("idle")
    expect(webviewRowStatus(session({ status: "exited" }))).toBe("done")
    expect(webviewRowStatus(session({ status: "killed", killedMidTurn: true }))).toBe("stopped")
    expect(webviewRowStatus(session({ status: "error" }))).toBe("failed")
  })

  it("marks a busy but silent session as stalled", () => {
    // 1h of silence while busy => stalled
    const stalled = session({
      busy: true,
      lastActivityAt: "2026-01-01T23:00:00Z",
    })
    expect(webviewRowStatus(stalled, NOW)).toBe("stalled")
  })
})

describe("rowActionFor", () => {
  it("offers stop for live sessions", () => {
    expect(rowActionFor(session({ status: "running" }))).toBe("stop")
    expect(rowActionFor(session({ status: "starting" }))).toBe("stop")
  })

  it("offers archive for terminal non-archived sessions", () => {
    expect(rowActionFor(session({ status: "exited" }))).toBe("archive")
    expect(rowActionFor(session({ status: "killed", killedMidTurn: false, turnsCompleted: 1 }))).toBe("archive")
    expect(rowActionFor(session({ status: "error" }))).toBe("archive")
  })

  it("offers unarchive for archived sessions", () => {
    expect(rowActionFor(session({ status: "exited", archived: true }))).toBe("unarchive")
  })

  it("offers no action for pending sessions", () => {
    expect(rowActionFor(session({ id: "pending:1", status: "starting" }))).toBeUndefined()
  })
})

describe("workspaceColorFor", () => {
  it("returns a stable color for a given slug", () => {
    const a = workspaceColorFor("studio")
    const b = workspaceColorFor("studio")
    expect(a.index).toBe(b.index)
    expect(a.css).toBe(b.css)
  })

  it("does not shift existing colors when a new workspace is added", () => {
    const studio = workspaceColorFor("studio")
    const other = workspaceColorFor("other")
    // re-check studio after other has been seen
    expect(workspaceColorFor("studio").index).toBe(studio.index)
    expect(workspaceColorFor("other").index).toBe(other.index)
  })

  it("uses a neutral gray for the unassigned sentinel", () => {
    expect(workspaceColorFor("__unassigned__").css).toBe("#808080")
  })
})

describe("WORKSPACE_PALETTE accessibility", () => {
  it("every accent color has a readable relative luminance", () => {
    for (const color of WORKSPACE_PALETTE) {
      const lum = relativeLuminance(color)
      // Mid-luminance accent colors read on both light and dark sidebars.
      expect(lum, color).toBeGreaterThanOrEqual(0.18)
      expect(lum, color).toBeLessThanOrEqual(0.75)
    }
  })
})

describe("buildSessionsWebviewModel", () => {
  it("produces one continuous list split into recent/older", () => {
    const sessions = [
      session({ id: "a", cwd: "/Code/studio", startedAt: "2026-01-01T23:00:00Z" }), // recent (1h before NOW)
      session({ id: "b", cwd: "/Code/studio", startedAt: "2025-12-01T00:00:00Z" }), // older
    ]
    const model = buildSessionsWebviewModel(sessions, studioConfig, { tab: "all", search: "", now: NOW })
    expect(model.section.recent.map(r => r.id)).toEqual(["a"])
    expect(model.section.older.map(r => r.id)).toEqual(["b"])
    expect(model.shownCount).toBe(2)
    expect(model.loadedCount).toBe(2)
    expect(model.serverTotal).toBe(2)
  })

  it("flattens parentSessionId children under their root as isSub rows, in the root's own section", () => {
    const sessions = [
      session({ id: "root", cwd: "/Code/studio", startedAt: "2026-01-01T23:00:00Z" }),
      session({ id: "child", cwd: "/Code/studio", parentSessionId: "root", startedAt: "2025-01-01T00:00:00Z" }),
    ]
    const model = buildSessionsWebviewModel(sessions, studioConfig, { tab: "all", search: "", now: NOW })
    const rows = model.section.recent
    expect(rows.map(r => r.id)).toEqual(["root", "child"])
    expect(rows.find(r => r.id === "root")?.isSub).toBe(false)
    expect(rows.find(r => r.id === "child")?.isSub).toBe(true)
    // A child never migrates to "older" on its own startedAt — it rides with its root.
    expect(model.section.older).toHaveLength(0)
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
    const model = buildSessionsWebviewModel(sessions, studioConfig, { tab: "all", search: "", now: NOW })
    const row = model.section.recent[0]! as WebviewRow
    expect(row.name).toBe("exec · canvakit-extract")
    expect(row.harnessGlyph).toBe("☿")
    expect(row.model).toBe("glm-5.2")
    expect(row.cost).toBe("$0.42")
    expect(row.ctxPercent).toBe(33)
    expect(row.tag).toBe("in-place")
    expect(row.workspace?.label).toBe("Agentik Studio")
    expect(row.workspace?.slug).toBe("studio")
  })

  it("filters by activity-based tabs, keeping terminal/stalled sessions out of Working/Idle/Done", () => {
    const sessions = [
      session({ id: "working", cwd: "/Code/studio", busy: true }),
      session({ id: "idle", cwd: "/Code/studio", busy: false }),
      session({ id: "await", cwd: "/Code/studio", awaitingInput: true }),
      session({ id: "done", cwd: "/Code/studio", status: "exited" }),
      session({ id: "stopped", cwd: "/Code/studio", status: "killed", killedMidTurn: true }),
      session({ id: "failed", cwd: "/Code/studio", status: "error" }),
      session({
        id: "stalled",
        cwd: "/Code/studio",
        busy: true,
        lastActivityAt: "2026-01-01T23:00:00Z",
      }),
    ]

    expect(
      buildSessionsWebviewModel(sessions, studioConfig, { tab: "working", search: "", now: NOW }).shownCount,
    ).toBe(1)
    expect(
      buildSessionsWebviewModel(sessions, studioConfig, { tab: "idle", search: "", now: NOW }).shownCount,
    ).toBe(1)
    expect(
      buildSessionsWebviewModel(sessions, studioConfig, { tab: "awaiting", search: "", now: NOW }).shownCount,
    ).toBe(1)
    expect(
      buildSessionsWebviewModel(sessions, studioConfig, { tab: "done", search: "", now: NOW }).shownCount,
    ).toBe(1)
    const stalledModel = buildSessionsWebviewModel(sessions, studioConfig, {
      tab: "stalled",
      search: "",
      now: NOW,
    })
    expect(stalledModel.shownCount).toBe(3)
    expect(stalledModel.section.recent.map(r => r.id).sort()).toEqual(["failed", "stalled", "stopped"])
  })

  it("retains an idle parent when its child matches the Working tab", () => {
    const sessions = [
      session({ id: "parent", cwd: "/Code/studio", busy: false }),
      session({ id: "child", cwd: "/Code/studio", parentSessionId: "parent", busy: true }),
    ]
    const model = buildSessionsWebviewModel(sessions, studioConfig, { tab: "working", search: "", now: NOW })
    expect(model.shownCount).toBe(2)
    const rows = model.section.recent
    expect(rows.map(r => ({ id: r.id, isSub: r.isSub, status: r.status }))).toEqual([
      { id: "parent", isSub: false, status: "idle" },
      { id: "child", isSub: true, status: "working" },
    ])
  })

  it("filters by the pinned search input via the reused predicate", () => {
    const sessions = [
      session({ id: "a", cwd: "/Code/studio", label: "sales-analysis" }),
      session({ id: "b", cwd: "/Code/studio", label: "unrelated" }),
    ]
    const model = buildSessionsWebviewModel(sessions, studioConfig, { tab: "all", search: "sales", now: NOW })
    expect(model.shownCount).toBe(1)
    expect(model.section.recent[0]!.id).toBe("a")
  })

  it("keeps workspace tags on rows as a single global list", () => {
    const sessions = [
      session({ id: "a", cwd: "/Code/studio", startedAt: "2026-01-01T23:00:00Z" }),
      session({ id: "b", cwd: "/Code/other", startedAt: "2026-01-01T22:00:00Z" }),
    ]
    const model = buildSessionsWebviewModel(sessions, multiConfig, { tab: "all", search: "", now: NOW })
    expect(model.section.recent.map(r => r.id)).toEqual(["a", "b"])
    expect(model.section.recent.find(r => r.id === "a")?.workspace?.slug).toBe("studio")
    expect(model.section.recent.find(r => r.id === "b")?.workspace?.slug).toBe("other")
  })

  it("shows only archived rows in the Archived tab", () => {
    const sessions = [
      session({ id: "live", cwd: "/Code/studio" }),
      session({ id: "archived", cwd: "/Code/studio", status: "exited", archived: true }),
    ]
    const model = buildSessionsWebviewModel(sessions, studioConfig, { tab: "archived", search: "", now: NOW })
    expect(model.section.recent.map(r => r.id)).toEqual(["archived"])
    expect(model.shownCount).toBe(1)
  })

  it("sorts the global list by recency with running sessions first", () => {
    const sessions = [
      session({ id: "older-running", cwd: "/Code/studio", startedAt: "2026-01-01T22:00:00Z" }),
      session({ id: "recent-done", cwd: "/Code/studio", status: "exited", startedAt: "2026-01-01T23:00:00Z" }),
    ]
    const model = buildSessionsWebviewModel(sessions, studioConfig, { tab: "all", search: "", now: NOW })
    // Running sorts before done within the recent section.
    expect(model.section.recent.map(r => r.id)).toEqual(["older-running", "recent-done"])
  })

  it("tracks loaded and server totals independently of shown rows", () => {
    const sessions = [
      session({ id: "a", label: "apple" }),
      session({ id: "b", label: "banana" }),
      session({ id: "c", label: "cherry" }),
    ]
    const model = buildSessionsWebviewModel(sessions, studioConfig, { tab: "all", search: "", now: NOW })
    expect(model.loadedCount).toBe(3)
    expect(model.serverTotal).toBe(3)
    const filtered = buildSessionsWebviewModel(sessions, studioConfig, { tab: "all", search: "apple", now: NOW })
    expect(filtered.shownCount).toBe(1)
    expect(filtered.loadedCount).toBe(3)
    expect(filtered.serverTotal).toBe(3)
  })
})

describe("summaryTextFor", () => {
  it("reports loaded-of-server-total when unfiltered", () => {
    const model = { section: { recent: [], older: [] }, shownCount: 0, loadedCount: 50, serverTotal: 283 }
    expect(summaryTextFor(model, false)).toBe("50 of 283 loaded")
  })

  it("reports shown-of-loaded when a filter is active", () => {
    const model = { section: { recent: [], older: [] }, shownCount: 3, loadedCount: 50, serverTotal: 283 }
    expect(summaryTextFor(model, true)).toBe("3 of 50 shown")
  })
})
