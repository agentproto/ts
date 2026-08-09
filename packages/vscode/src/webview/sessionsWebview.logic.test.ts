import { describe, expect, it } from "vitest"

import type { SessionSummary, WorkspacesConfig } from "../client/types.js"
import {
  autoGroupOf,
  buildSessionsWebviewModel,
  collapseCronRuns,
  cronJobIdOf,
  formatCost,
  gateApproved,
  harnessGlyphFor,
  HARNESS_GLYPHS,
  HARNESS_GLYPH_FALLBACK,
  isSystemPreviewLine,
  laneOf,
  nestByLineage,
  previewTextFor,
  relativeLuminance,
  rowActionFor,
  sectionFor,
  stallTooltipFor,
  stripMarkdownToText,
  summaryTextFor,
  UNASSIGNED_COLOR_INDEX,
  UNASSIGNED_SLUG,
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

/** Default opts: agents lane, all projects, no search. */
function opts(over: Partial<Parameters<typeof buildSessionsWebviewModel>[2]> = {}) {
  return { lane: "agents" as const, project: null, search: "", now: NOW, ...over }
}

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

describe("previewTextFor (item 1: genuine, single-line, markdown-free preview)", () => {
  it("skips the daemon's context-continuity / system bookkeeping line", () => {
    expect(
      previewTextFor({
        activitySummary: {
          text: "[context] context at 69% — waiting for user decision (continue fresh…)",
          state: "en attente",
          at: "",
        },
      }),
    ).toBeUndefined()
    // Un-tagged continuity phrasing is caught too.
    expect(
      previewTextFor({ activitySummary: { text: "context at 88% — waiting for user decision", state: "", at: "" } }),
    ).toBeUndefined()
  })

  it("strips markdown to a single plain line", () => {
    expect(
      previewTextFor({
        activitySummary: { text: "Edited **sessionsWebviewPanel.ts** and ran `pnpm test`", state: "", at: "" },
      }),
    ).toBe("Edited sessionsWebviewPanel.ts and ran pnpm test")
    expect(
      previewTextFor({ activitySummary: { text: "Opened [the PR](https://x/y)\n\nnext step", state: "", at: "" } }),
    ).toBe("Opened the PR next step")
  })

  it("truncates a long preview to one clamped line", () => {
    const long = "a".repeat(200)
    const preview = previewTextFor({ activitySummary: { text: long, state: "", at: "" } })!
    expect(preview.length).toBeLessThanOrEqual(72)
    expect(preview.endsWith("…")).toBe(true)
  })

  it("returns undefined when there is no activity summary at all", () => {
    expect(previewTextFor({})).toBeUndefined()
    expect(previewTextFor({ activitySummary: { text: "   ", state: "", at: "" } })).toBeUndefined()
  })

  it("does not swallow a genuine message that merely mentions context", () => {
    expect(
      previewTextFor({ activitySummary: { text: "Refactored the context provider hook", state: "", at: "" } }),
    ).toBe("Refactored the context provider hook")
  })
})

describe("isSystemPreviewLine / stripMarkdownToText", () => {
  it("flags tagged and continuity lines only", () => {
    expect(isSystemPreviewLine("[system] booting adapter")).toBe(true)
    expect(isSystemPreviewLine("[continuity] checkpoint saved")).toBe(true)
    expect(isSystemPreviewLine("continue fresh in a new session")).toBe(true)
    expect(isSystemPreviewLine("Wrote the report")).toBe(false)
  })
  it("flattens emphasis, code, headings and lists", () => {
    expect(stripMarkdownToText("# Title\n- **one**\n- `two`")).toBe("Title one two")
  })
})

describe("nestByLineage (item 6: subagents under their spawner)", () => {
  const row = (id: string, parentSessionId?: string): WebviewRow =>
    ({ id, depth: 0, session: session({ id, parentSessionId }) }) as unknown as WebviewRow

  it("stacks children under their parent with increasing depth", () => {
    const rows = [row("root"), row("child-a", "root"), row("grandchild", "child-a"), row("child-b", "root")]
    const nested = nestByLineage(rows)
    expect(nested.map(r => [r.id, r.depth])).toEqual([
      ["root", 0],
      ["child-a", 1],
      ["grandchild", 2],
      ["child-b", 1],
    ])
  })

  it("treats a child whose parent is absent from the bucket as a root", () => {
    const rows = [row("orphan", "missing-parent"), row("plain")]
    const nested = nestByLineage(rows)
    expect(nested.map(r => [r.id, r.depth])).toEqual([
      ["orphan", 0],
      ["plain", 0],
    ])
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
    const stalled = session({ busy: true, lastActivityAt: "2026-01-01T23:00:00Z" })
    expect(webviewRowStatus(stalled, NOW)).toBe("stalled")
  })

  it("refines an idle session with a busy subtree into 'delegating' (#session-visibility)", () => {
    expect(webviewRowStatus(session({ busy: false, childrenBusy: 2 }))).toBe("delegating")
    // Only refines idle — a working session stays working, awaiting stays awaiting.
    expect(webviewRowStatus(session({ busy: true, childrenBusy: 2 }))).toBe("working")
    expect(webviewRowStatus(session({ awaitingInput: true, childrenBusy: 2 }))).toBe("awaiting")
  })

  it("refines an idle, supervised session into 'parked'; delegating outranks parked", () => {
    expect(webviewRowStatus(session({ busy: false, watchers: 1 }))).toBe("parked")
    // A busy subtree wins over a mere waiter.
    expect(webviewRowStatus(session({ busy: false, childrenBusy: 1, watchers: 1 }))).toBe("delegating")
  })
})

describe("rowActionFor", () => {
  it("offers stop for live sessions", () => {
    expect(rowActionFor(session({ status: "running" }))).toBe("stop")
    expect(rowActionFor(session({ status: "starting" }))).toBe("stop")
  })
  it("offers archive for terminal non-archived sessions", () => {
    expect(rowActionFor(session({ status: "exited" }))).toBe("archive")
    expect(rowActionFor(session({ status: "error" }))).toBe("archive")
  })
  it("offers unarchive for archived sessions regardless of status", () => {
    expect(rowActionFor(session({ status: "exited", archived: true }))).toBe("unarchive")
  })
  it("offers no action for pending sessions", () => {
    expect(rowActionFor(session({ id: "pending:1", status: "starting" }))).toBeUndefined()
  })
})

describe("workspaceColorFor", () => {
  it("returns a stable color for a given slug", () => {
    expect(workspaceColorFor("studio")).toEqual(workspaceColorFor("studio"))
  })
  it("uses a neutral gray for the unassigned sentinel", () => {
    expect(workspaceColorFor(UNASSIGNED_SLUG).css).toBe("#808080")
  })

  it("an override takes precedence over the hash default", () => {
    const hashDefault = workspaceColorFor("studio")
    const overrideIndex = (hashDefault.index + 1) % WORKSPACE_PALETTE.length
    const overridden = workspaceColorFor("studio", { studio: overrideIndex })
    expect(overridden.index).toBe(overrideIndex)
    expect(overridden.css).toBe(WORKSPACE_PALETTE[overrideIndex])
    expect(overridden.css).not.toBe(hashDefault.css)
  })

  it("an override for the neutral unassigned index resolves to the neutral gray", () => {
    expect(workspaceColorFor("studio", { studio: UNASSIGNED_COLOR_INDEX })).toEqual({
      index: UNASSIGNED_COLOR_INDEX,
      css: "#808080",
    })
  })

  it("an override only applies to its own slug — other slugs keep their hash default", () => {
    const studioDefault = workspaceColorFor("studio")
    expect(workspaceColorFor("studio", { other: 3 })).toEqual(studioDefault)
  })

  it("no override present (or reset — key absent) falls back to the hash default, unchanged", () => {
    expect(workspaceColorFor("studio", {})).toEqual(workspaceColorFor("studio"))
    expect(workspaceColorFor("studio", undefined)).toEqual(workspaceColorFor("studio"))
  })

  it("ignores an out-of-range or non-integer override and falls back to the hash default", () => {
    const hashDefault = workspaceColorFor("studio")
    expect(workspaceColorFor("studio", { studio: -1 })).toEqual(hashDefault)
    expect(workspaceColorFor("studio", { studio: UNASSIGNED_COLOR_INDEX + 1 })).toEqual(hashDefault)
    expect(workspaceColorFor("studio", { studio: 1.5 })).toEqual(hashDefault)
  })
})

describe("WORKSPACE_PALETTE accessibility", () => {
  it("every accent color has a readable relative luminance", () => {
    for (const color of WORKSPACE_PALETTE) {
      const lum = relativeLuminance(color)
      expect(lum, color).toBeGreaterThanOrEqual(0.18)
      expect(lum, color).toBeLessThanOrEqual(0.75)
    }
  })
})

// ─── Design B: lane classification ──────────────────────────────────────────
describe("laneOf / autoGroupOf", () => {
  it("routes human-origin sessions to the agents lane", () => {
    expect(laneOf(session())).toBe("agents")
    expect(laneOf(session({ origin: "vscode" }))).toBe("agents")
    expect(autoGroupOf(session())).toBeUndefined()
  })
  it("routes gate/cron/command sessions to the auto lane, sub-grouped", () => {
    expect(autoGroupOf(session({ origin: "gate" }))).toBe("gate")
    expect(autoGroupOf(session({ origin: "cron" }))).toBe("cron")
    expect(autoGroupOf(session({ kind: "command" }))).toBe("command")
    expect(laneOf(session({ origin: "gate" }))).toBe("auto")
    expect(laneOf(session({ kind: "command" }))).toBe("auto")
  })
  it("prefers gate over cron over command when tells overlap", () => {
    expect(autoGroupOf(session({ origin: "gate", kind: "command" }))).toBe("gate")
    expect(autoGroupOf(session({ origin: "cron", kind: "command" }))).toBe("cron")
  })
})

// ─── Design B: attention sections ───────────────────────────────────────────
describe("sectionFor", () => {
  it("folds each activity into its fixed-priority section", () => {
    expect(sectionFor(session({ awaitingInput: true }))).toBe("needs-you")
    expect(sectionFor(session({ busy: true }))).toBe("running")
    expect(sectionFor(session({ busy: true, lastActivityAt: "2026-01-01T23:00:00Z" }), NOW)).toBe("attention")
    expect(sectionFor(session({ status: "error" }))).toBe("attention")
    expect(sectionFor(session({ busy: false }))).toBe("quiet")
    expect(sectionFor(session({ status: "exited" }))).toBe("earlier")
    expect(sectionFor(session({ status: "killed", killedMidTurn: true }))).toBe("earlier")
  })
})

describe("buildSessionsWebviewModel — attention sections", () => {
  it("organizes the agents lane into the five sections in fixed order", () => {
    const sessions = [
      session({ id: "await", cwd: "/Code/studio", awaitingInput: true }),
      session({ id: "run", cwd: "/Code/studio", busy: true }),
      session({ id: "fail", cwd: "/Code/studio", status: "error" }),
      session({ id: "idle", cwd: "/Code/studio", busy: false }),
      session({ id: "done", cwd: "/Code/studio", status: "exited" }),
    ]
    const model = buildSessionsWebviewModel(sessions, studioConfig, opts())
    expect(model.groups.map(g => g.key)).toEqual(["needs-you", "running", "attention", "quiet", "earlier"])
    expect(model.groups.map(g => g.label)).toEqual(["Needs you", "Running", "Attention", "Quiet", "Earlier"])
    expect(model.groups.find(g => g.key === "earlier")?.hint).toBe("last 24 h")
    expect(model.shownCount).toBe(5)
  })

  it("omits empty sections", () => {
    const model = buildSessionsWebviewModel([session({ cwd: "/Code/studio", awaitingInput: true })], studioConfig, opts())
    expect(model.groups.map(g => g.key)).toEqual(["needs-you"])
  })

  it("groups stalled and failed together under Attention", () => {
    const sessions = [
      session({ id: "stalled", cwd: "/Code/studio", busy: true, lastActivityAt: "2026-01-01T23:00:00Z" }),
      session({ id: "failed", cwd: "/Code/studio", status: "error" }),
    ]
    const model = buildSessionsWebviewModel(sessions, studioConfig, opts())
    const attention = model.groups.find(g => g.key === "attention")
    expect(attention?.rows.map(r => r.id).sort()).toEqual(["failed", "stalled"])
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
        busy: true,
      }),
    ]
    const model = buildSessionsWebviewModel(sessions, studioConfig, opts())
    const row = model.groups[0]!.rows[0]! as WebviewRow
    expect(row.name).toBe("exec · canvakit-extract")
    expect(row.harnessGlyph).toBe("☿")
    expect(row.model).toBe("glm-5.2")
    expect(row.cost).toBe("$0.42")
    expect(row.ctxPercent).toBe(33)
    expect(row.tag).toBe("in-place")
    expect(row.workspace?.slug).toBe("studio")
  })
})

// ─── Design B: Agents | Auto split ──────────────────────────────────────────
describe("buildSessionsWebviewModel — lane split", () => {
  const mixed = [
    session({ id: "human", cwd: "/Code/studio", busy: true }),
    session({ id: "gate", cwd: "/Code/studio", origin: "gate", status: "exited" }),
    session({ id: "cron", cwd: "/Code/studio", origin: "cron", label: "cron:cron_abc12345", status: "exited" }),
    session({ id: "cmd", cwd: "/Code/studio", kind: "command", status: "exited" }),
  ]

  it("counts both lanes regardless of the selected lane", () => {
    const model = buildSessionsWebviewModel(mixed, studioConfig, opts({ lane: "agents" }))
    expect(model.laneCounts).toEqual({ agents: 1, auto: 3 })
  })

  it("shows only human-origin sessions in the agents lane", () => {
    const model = buildSessionsWebviewModel(mixed, studioConfig, opts({ lane: "agents" }))
    const ids = model.groups.flatMap(g => g.rows.map(r => r.id))
    expect(ids).toEqual(["human"])
  })

  it("groups the auto lane into Gate reviews / Crons / Commands, in order", () => {
    const model = buildSessionsWebviewModel(mixed, studioConfig, opts({ lane: "auto" }))
    expect(model.groups.map(g => g.key)).toEqual(["gate", "cron", "command"])
    expect(model.groups.map(g => g.label)).toEqual(["Gate reviews", "Crons", "Commands"])
  })

  it("cleans up the machine-session name (cron · shortId, command · shortId, gate-review)", () => {
    const model = buildSessionsWebviewModel(mixed, studioConfig, opts({ lane: "auto" }))
    const cron = model.groups.find(g => g.key === "cron")!.rows[0]!
    expect(cron.name).toBe("cron")
    expect(cron.idMono).toBe("abc12345")
    const gate = model.groups.find(g => g.key === "gate")!.rows[0]!
    expect(gate.name).toBe("gate-review")
    const cmd = model.groups.find(g => g.key === "command")!.rows[0]!
    expect(cmd.name).toBe("command")
  })
})

// ─── Design B: cron collapsing ──────────────────────────────────────────────
describe("cronJobIdOf / collapseCronRuns", () => {
  it("extracts a cron job id from the cron:<jobId> label", () => {
    expect(cronJobIdOf({ label: "cron:cron_d8ee2e36-abcd" })).toBe("cron_d8ee2e36-abcd")
    expect(cronJobIdOf({ label: "exec · foo" })).toBeUndefined()
    expect(cronJobIdOf({ label: undefined })).toBeUndefined()
  })

  it("collapses consecutive same-job cron runs into one row with a run count", () => {
    const cronRow = (id: string, jobId: string): WebviewRow =>
      ({ id, session: session({ id, label: `cron:${jobId}` }), runs: undefined }) as unknown as WebviewRow
    const rows = [
      cronRow("r3", "cron_a"),
      cronRow("r2", "cron_a"),
      cronRow("r1", "cron_a"),
      cronRow("q1", "cron_b"),
    ]
    const collapsed = collapseCronRuns(rows)
    expect(collapsed.map(r => r.id)).toEqual(["r3", "q1"])
    expect(collapsed[0]!.runs).toBe(3)
    expect(collapsed[1]!.runs).toBeUndefined()
  })

  it("collapses cron runs end-to-end in the auto lane", () => {
    const cronRun = (id: string, at: string) =>
      session({ id, cwd: "/Code/studio", origin: "cron", label: "cron:cron_d8ee2e36", status: "exited", lastActivityAt: at })
    const sessions = [
      cronRun("run-3", "2026-01-01T23:30:00Z"),
      cronRun("run-2", "2026-01-01T23:20:00Z"),
      cronRun("run-1", "2026-01-01T23:10:00Z"),
    ]
    const model = buildSessionsWebviewModel(sessions, studioConfig, opts({ lane: "auto" }))
    const crons = model.groups.find(g => g.key === "cron")!
    expect(crons.rows).toHaveLength(1)
    expect(crons.rows[0]!.runs).toBe(3)
    expect(crons.rows[0]!.idMono).toBe("d8ee2e36")
    expect(model.shownCount).toBe(1)
  })
})

describe("buildSessionsWebviewModel — colorOverrides", () => {
  it("an override reflects in both the rail chip and the row's workspace colorIndex", () => {
    const sessions = [session({ id: "a", cwd: "/Code/studio", busy: true })]
    const hashDefault = workspaceColorFor("studio")
    const overrideIndex = (hashDefault.index + 1) % WORKSPACE_PALETTE.length
    const model = buildSessionsWebviewModel(sessions, studioConfig, opts({ colorOverrides: { studio: overrideIndex } }))
    const railEntry = model.rail.find(r => r.slug === "studio")
    expect(railEntry?.colorIndex).toBe(overrideIndex)
    expect(railEntry?.css).toBe(WORKSPACE_PALETTE[overrideIndex])
    const row = model.groups.flatMap(g => g.rows).find(r => r.id === "a")
    expect(row?.workspace?.colorIndex).toBe(overrideIndex)
  })

  it("with no colorOverrides, rail/row colors are unchanged from the hash default", () => {
    const sessions = [session({ id: "a", cwd: "/Code/studio", busy: true })]
    const withOverrides = buildSessionsWebviewModel(sessions, studioConfig, opts({ colorOverrides: {} }))
    const withoutOverrides = buildSessionsWebviewModel(sessions, studioConfig, opts())
    expect(withOverrides.rail.find(r => r.slug === "studio")?.colorIndex).toBe(
      withoutOverrides.rail.find(r => r.slug === "studio")?.colorIndex,
    )
  })
})

describe("gateApproved", () => {
  it("flags an approving gate session and nothing else", () => {
    expect(gateApproved(session({ origin: "gate", activitySummary: { text: "Verdict: approved", state: "done", at: "" } }))).toBe(true)
    expect(gateApproved(session({ origin: "gate", activitySummary: { text: "Verdict: changes requested", state: "done", at: "" } }))).toBe(false)
    expect(gateApproved(session({ activitySummary: { text: "approved" } as never }))).toBe(false)
  })
})

describe("stallTooltipFor", () => {
  it("is undefined when the session isn't flagged by the daemon's turn-liveness watchdog", () => {
    expect(stallTooltipFor(session(), NOW)).toBeUndefined()
  })

  it("reports the silent duration since the daemon-stamped stalledSinceMs, not any client-side guess", () => {
    const stalledSinceMs = NOW - 6 * 60_000
    expect(stallTooltipFor(session({ stalledSinceMs }), NOW)).toBe(
      "no adapter activity for 6min mid-turn — stream may be dead",
    )
  })

  it("clamps to non-negative when stalledSinceMs is somehow after now", () => {
    expect(stallTooltipFor(session({ stalledSinceMs: NOW + 60_000 }), NOW)).toBe(
      "no adapter activity for 0s mid-turn — stream may be dead",
    )
  })
})

describe("toRow (via buildSessionsWebviewModel) — stall badge", () => {
  it("carries stallTooltip through onto the rendered row only when stalledSinceMs is set", () => {
    const flagged = session({ id: "flagged", busy: true, stalledSinceMs: NOW - 6 * 60_000 })
    const healthy = session({ id: "healthy", busy: true })
    const model = buildSessionsWebviewModel(
      [flagged, healthy],
      { version: 1, workspaces: [] },
      opts(),
    )
    const rows = model.groups.flatMap(g => g.rows)
    const flaggedRow = rows.find(r => r.id === "flagged")
    const healthyRow = rows.find(r => r.id === "healthy")
    expect(flaggedRow?.stallTooltip).toBe("no adapter activity for 6min mid-turn — stream may be dead")
    expect(healthyRow?.stallTooltip).toBeUndefined()
  })
})

// ─── Design B: project rail ─────────────────────────────────────────────────
describe("buildSessionsWebviewModel — project rail", () => {
  it("builds an All chip plus one chip per workspace with counts", () => {
    const sessions = [
      session({ id: "a", cwd: "/Code/studio", busy: true }),
      session({ id: "b", cwd: "/Code/other", busy: true }),
      session({ id: "c", cwd: "/Code/other", busy: true }),
    ]
    const model = buildSessionsWebviewModel(sessions, multiConfig, opts())
    expect(model.rail[0]).toMatchObject({ slug: null, label: "All", count: 3 })
    const studio = model.rail.find(r => r.slug === "studio")
    const other = model.rail.find(r => r.slug === "other")
    expect(studio?.count).toBe(1)
    expect(other?.count).toBe(2)
  })

  it("lights the ochre awaiting dot only on projects holding an awaiting session", () => {
    const sessions = [
      session({ id: "a", cwd: "/Code/studio", awaitingInput: true }),
      session({ id: "b", cwd: "/Code/other", busy: true }),
    ]
    const model = buildSessionsWebviewModel(sessions, multiConfig, opts())
    expect(model.rail.find(r => r.slug === null)?.awaiting).toBe(true)
    expect(model.rail.find(r => r.slug === "studio")?.awaiting).toBe(true)
    expect(model.rail.find(r => r.slug === "other")?.awaiting).toBe(false)
  })

  it("scopes the rail to the current lane", () => {
    const sessions = [
      session({ id: "human", cwd: "/Code/studio", busy: true }),
      session({ id: "gate", cwd: "/Code/other", origin: "gate", status: "exited" }),
    ]
    const agents = buildSessionsWebviewModel(sessions, multiConfig, opts({ lane: "agents" }))
    expect(agents.rail.map(r => r.slug)).toEqual([null, "studio"])
    const auto = buildSessionsWebviewModel(sessions, multiConfig, opts({ lane: "auto" }))
    expect(auto.rail.map(r => r.slug)).toEqual([null, "other"])
  })

  it("filters the list to the selected project", () => {
    const sessions = [
      session({ id: "a", cwd: "/Code/studio", busy: true }),
      session({ id: "b", cwd: "/Code/other", busy: true }),
    ]
    const model = buildSessionsWebviewModel(sessions, multiConfig, opts({ project: "studio" }))
    expect(model.groups.flatMap(g => g.rows.map(r => r.id))).toEqual(["a"])
  })
})

describe("buildSessionsWebviewModel — filtering + totals", () => {
  it("hides archived sessions entirely by default", () => {
    const sessions = [
      session({ id: "live", cwd: "/Code/studio", busy: true }),
      session({ id: "arch", cwd: "/Code/studio", status: "exited", archived: true }),
    ]
    const model = buildSessionsWebviewModel(sessions, studioConfig, opts())
    expect(model.groups.flatMap(g => g.rows.map(r => r.id))).toEqual(["live"])
  })

  it("toggle ON shows ONLY archived rows — active sessions are excluded, not merged in", () => {
    const sessions = [
      session({ id: "live", cwd: "/Code/studio", busy: true }),
      session({ id: "arch", cwd: "/Code/studio", status: "exited", archived: true }),
    ]
    const model = buildSessionsWebviewModel(sessions, studioConfig, opts({ includeArchived: true }))
    const rows = model.groups.flatMap(g => g.rows)
    expect(rows.map(r => r.id)).toEqual(["arch"])
    expect(rows[0]?.archived).toBe(true)
  })

  it("toggle OFF shows ONLY active rows — archived sessions are excluded", () => {
    const sessions = [
      session({ id: "live", cwd: "/Code/studio", busy: true }),
      session({ id: "arch", cwd: "/Code/studio", status: "exited", archived: true }),
    ]
    const model = buildSessionsWebviewModel(sessions, studioConfig, opts({ includeArchived: false }))
    const rows = model.groups.flatMap(g => g.rows)
    expect(rows.map(r => r.id)).toEqual(["live"])
  })

  it("an empty archived set renders no rows in the archived-only view", () => {
    const sessions = [session({ id: "live", cwd: "/Code/studio", busy: true })]
    const model = buildSessionsWebviewModel(sessions, studioConfig, opts({ includeArchived: true }))
    expect(model.groups.flatMap(g => g.rows)).toEqual([])
    expect(model.shownCount).toBe(0)
  })

  it("a live continuation of an archived predecessor doesn't leak into the wrong view", () => {
    const sessions = [
      session({ id: "old", cwd: "/Code/studio", status: "exited", archived: true }),
      session({ id: "new", cwd: "/Code/studio", busy: true, continuedFrom: "old" }),
    ]
    const archivedOnly = buildSessionsWebviewModel(sessions, studioConfig, opts({ includeArchived: true }))
    expect(archivedOnly.groups.flatMap(g => g.rows.map(r => r.id))).toEqual(["old"])

    const activeOnly = buildSessionsWebviewModel(sessions, studioConfig, opts({ includeArchived: false }))
    expect(activeOnly.groups.flatMap(g => g.rows.map(r => r.id))).toEqual(["new"])
  })

  it("honors an explicit loadedCount for the footer (item 2 pinned extras)", () => {
    const sessions = [session({ id: "a", busy: true }), session({ id: "b", busy: true })]
    const model = buildSessionsWebviewModel(sessions, studioConfig, opts({ loadedCount: 1, serverTotal: 50 }))
    expect(model.loadedCount).toBe(1)
  })

  it("marks a kept-alive session as watched (item 5)", () => {
    const model = buildSessionsWebviewModel(
      [session({ id: "w", cwd: "/Code/studio", busy: true, keepAlive: true })],
      studioConfig,
      opts(),
    )
    expect(model.groups[0]!.rows[0]!.watched).toBe(true)
  })

  it("nests a subagent under its spawner in the same section (item 6)", () => {
    const sessions = [
      session({ id: "parent", cwd: "/Code/studio", busy: true }),
      session({ id: "child", cwd: "/Code/studio", busy: true, parentSessionId: "parent" }),
    ]
    const model = buildSessionsWebviewModel(sessions, studioConfig, opts())
    const running = model.groups.find(g => g.key === "running")!
    const parent = running.rows.find(r => r.id === "parent")!
    const child = running.rows.find(r => r.id === "child")!
    expect(parent.depth).toBe(0)
    expect(child.depth).toBe(1)
    expect(running.rows.indexOf(parent)).toBeLessThan(running.rows.indexOf(child))
  })

  it("filters by the pinned search input via the reused predicate", () => {
    const sessions = [
      session({ id: "a", cwd: "/Code/studio", label: "sales-analysis", busy: true }),
      session({ id: "b", cwd: "/Code/studio", label: "unrelated", busy: true }),
    ]
    const model = buildSessionsWebviewModel(sessions, studioConfig, opts({ search: "sales" }))
    expect(model.shownCount).toBe(1)
    expect(model.groups[0]!.rows[0]!.id).toBe("a")
  })

  it("tracks loaded and server totals independently of shown rows", () => {
    const sessions = [session({ id: "a", label: "apple", busy: true }), session({ id: "b", label: "banana", busy: true })]
    const model = buildSessionsWebviewModel(sessions, studioConfig, opts({ serverTotal: 283 }))
    expect(model.loadedCount).toBe(2)
    expect(model.serverTotal).toBe(283)
  })
})

describe("summaryTextFor", () => {
  const base = { lane: "agents" as const, rail: [], laneCounts: { agents: 0, auto: 0 }, groups: [] }
  it("reports loaded-of-server-total when unfiltered", () => {
    expect(summaryTextFor({ ...base, shownCount: 0, loadedCount: 50, serverTotal: 283 }, false)).toBe("50 of 283 loaded")
  })
  it("reports shown-of-loaded when a filter is active", () => {
    expect(summaryTextFor({ ...base, shownCount: 3, loadedCount: 50, serverTotal: 283 }, true)).toBe("3 of 50 shown")
  })
})
