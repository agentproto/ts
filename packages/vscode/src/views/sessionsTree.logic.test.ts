import { describe, expect, it } from "vitest"

import type { SessionDescriptor } from "../client/types.js"
import {
  SEPARATOR_ID,
  STALL_AFTER_MS,
  bucketFor,
  buildSessionRows,
  buildSessionTree,
  compareSessions,
  contextValueFor,
  contextPercent,
  descriptionFor,
  formatDuration,
  activityFor,
  iconFor,
  isStalled,
  labelFor,
  relativeTime,
  silentForMs,
  tooltipFieldsFor,
  TREE_REPAINT_INTERVAL_MS,
  type SeparatorNode,
  type SessionNode,
  type TreeNode,
} from "./sessionsTree.logic.js"

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

describe("labelFor", () => {
  it("prefers label over command", () => {
    expect(labelFor(session({ label: "sales-analysis" }))).toBe("sales-analysis")
  })
  it("falls back to command when label is unset", () => {
    expect(labelFor(session({ label: undefined }))).toBe("claude-code --print")
  })
})

describe("descriptionFor", () => {
  it("joins adapterSlug, model, status", () => {
    expect(descriptionFor(session({ adapterSlug: "claude-code", model: "sonnet" }))).toBe(
      "claude-code · sonnet · running",
    )
  })
  it("falls back to kind when adapterSlug is unset, omits model when unset", () => {
    expect(descriptionFor(session({ adapterSlug: undefined, model: undefined, kind: "terminal" }))).toBe(
      "terminal · running",
    )
  })

  describe("with a DescriptionContext", () => {
    const now = Date.parse("2026-01-06T00:00:00Z")

    it("renders workspace · relative time", () => {
      const s = session({ startedAt: "2026-01-01T00:00:00Z", tokensIn: 120, tokensOut: 45 })
      // Token counts are deliberately absent: a raw +in -out per row is a
      // number nobody acts on. See descriptionFor's docblock.
      expect(descriptionFor(s, { workspaceLabel: "Agentik Studio", now })).toBe(
        "Agentik Studio · 5 days ago",
      )
    })
    it("omits workspace when unset", () => {
      const s = session({ startedAt: "2026-01-01T00:00:00Z", tokensIn: 10, tokensOut: 5 })
      expect(descriptionFor(s, { now })).toBe("5 days ago")
    })
    it("omits relative time when ctx.now is unset", () => {
      const s = session({ startedAt: "2026-01-01T00:00:00Z" })
      expect(descriptionFor(s, { workspaceLabel: "ws" })).toBe("ws")
    })
    it("returns an empty string when ctx has no resolvable parts", () => {
      expect(descriptionFor(session(), {})).toBe("")
    })
  })
})

describe("relativeTime", () => {
  const now = Date.parse("2026-01-10T12:00:00Z")

  it("just now for sub-45s deltas", () => {
    expect(relativeTime("2026-01-10T11:59:30Z", now)).toBe("just now")
  })
  it("minutes ago", () => {
    expect(relativeTime("2026-01-10T11:58:00Z", now)).toBe("2 mins ago")
    expect(relativeTime("2026-01-10T11:59:00Z", now)).toBe("1 min ago")
  })
  it("hours ago", () => {
    expect(relativeTime("2026-01-10T10:00:00Z", now)).toBe("2 hrs ago")
    expect(relativeTime("2026-01-10T11:00:00Z", now)).toBe("1 hr ago")
  })
  it("days ago", () => {
    expect(relativeTime("2026-01-05T12:00:00Z", now)).toBe("5 days ago")
    expect(relativeTime("2026-01-09T12:00:00Z", now)).toBe("1 day ago")
  })
  it("months ago", () => {
    expect(relativeTime("2025-11-01T12:00:00Z", now)).toBe("2 months ago")
  })
  it("years ago", () => {
    expect(relativeTime("2024-01-10T12:00:00Z", now)).toBe("2 years ago")
  })
  it("clamps a future timestamp (clock skew) to just now instead of a negative duration", () => {
    expect(relativeTime("2026-01-10T13:00:00Z", now)).toBe("just now")
  })
  it("renders an em dash for an unparsable timestamp", () => {
    expect(relativeTime("not-a-date", now)).toBe("—")
  })
})

describe("subagents nest under their spawner", () => {
  const now = Date.parse("2026-07-16T12:00:00Z")
  const at = (iso: string) => iso

  it("puts children under the session that spawned them, at any depth", () => {
    const rows = buildSessionRows(
      [
        session({ id: "leaf", parentSessionId: "worker", startedAt: at("2026-07-16T11:00:00Z") }),
        session({ id: "root", startedAt: at("2026-07-16T11:00:00Z") }),
        session({ id: "worker", parentSessionId: "root", startedAt: at("2026-07-16T11:00:00Z") }),
      ],
      now,
    )
    // One top-level row: the spawner. The chain hangs off it.
    expect(rows).toHaveLength(1)
    const root = rows[0] as SessionNode
    expect(root.session.id).toBe("root")
    expect(root.children.map(c => c.session.id)).toEqual(["worker"])
    expect(root.children[0]!.children.map(c => c.session.id)).toEqual(["leaf"])
  })

  it("says how many subagents a spawner has, so a collapsed row still tells you", () => {
    const rows = buildSessionRows(
      [
        session({ id: "root", startedAt: at("2026-07-16T11:00:00Z") }),
        session({ id: "a", parentSessionId: "root", startedAt: at("2026-07-16T11:00:00Z") }),
        session({ id: "b", parentSessionId: "root", startedAt: at("2026-07-16T11:00:00Z") }),
      ],
      now,
    )
    const root = rows[0] as SessionNode
    expect(descriptionFor(root.session, { now, childCount: root.children.length })).toBe(
      "1 hr ago · 2 subagents",
    )
    // A leaf claims nothing.
    expect(descriptionFor(root.children[0]!.session, { now, childCount: 0 })).toBe("1 hr ago")
  })

  it("keeps a subtree with its spawner across the 24h divider", () => {
    // A child started today under a parent started last week must not float
    // up to the recent side on its own — the subtree belongs to its root.
    const rows = buildSessionRows(
      [
        session({ id: "old-root", startedAt: at("2026-07-09T11:00:00Z") }),
        session({ id: "fresh-child", parentSessionId: "old-root", startedAt: at("2026-07-16T11:00:00Z") }),
        session({ id: "recent", startedAt: at("2026-07-16T11:00:00Z") }),
      ],
      now,
    )
    const ids = rows.map(r => ("kind" in r ? r.id : r.session.id))
    expect(ids).toEqual(["recent", SEPARATOR_ID, "old-root"])
    const oldRoot = rows[2] as SessionNode
    expect(oldRoot.children.map(c => c.session.id)).toEqual(["fresh-child"])
  })

  it("never orphans a child whose spawner is gone — it becomes a root, not a dropped row", () => {
    const rows = buildSessionRows(
      [session({ id: "orphan", parentSessionId: "reaped", startedAt: at("2026-07-16T11:00:00Z") })],
      now,
    )
    expect(rows).toHaveLength(1)
    expect((rows[0] as SessionNode).session.id).toBe("orphan")
  })
})

describe("activityFor", () => {
  it("names what a session is doing, not whether its process is up", () => {
    expect(activityFor(session())).toBe("idle")
    expect(activityFor(session({ busy: true }))).toBe("working")
    expect(activityFor(session({ awaitingInput: true }))).toBe("needs-you")
    expect(activityFor(session({ awaitingPermission: true }))).toBe("needs-you")
    expect(activityFor(session({ status: "exited", exitCode: 0 }))).toBe("done")
    expect(activityFor(session({ status: "error" }))).toBe("failed")
    expect(activityFor(session({ status: "exited", exitCode: 7 }))).toBe("failed")
  })

  it("being STOPPED is not failing — SIGTERM's exit code must not read as a crash", () => {
    // Stop sends SIGTERM, so a stopped session carries exitCode 143 and the
    // old isErrored() check painted it red. Two sessions on a real daemon
    // were marked as failures purely because the user pressed Stop.
    expect(activityFor(session({ status: "killed", exitCode: 143 }))).toBe("stopped")
    expect(activityFor(session({ status: "killed", exitCode: 137 }))).toBe("stopped")
    expect(activityFor(session({ status: "killed" }))).toBe("stopped")
  })

  it("ranks what needs a human above everything else", () => {
    expect(activityFor(session({ busy: true, awaitingInput: true }))).toBe("needs-you")
  })
})

describe("iconFor", () => {
  it("a dot at rest, spinning outline in motion", () => {
    // `play` (▷) is an ACTION glyph — it read "press me to run" on the most
    // common row on screen. A dot is a state.
    expect(iconFor(session()).id).toMatch(/^circle-(filled|outline)$/)
    // One agent thinking, not two things being reconciled (`sync~spin`).
    expect(iconFor(session({ busy: true }))).toEqual({ id: "loading~spin" })
  })

  it("fills the idle dot only while the session's output is unread", () => {
    // Weight is the read-receipt: filled = "something here you haven't seen".
    // Every idle session used to be filled, which made the loudest mark on
    // screen the one carrying no information.
    const idle = session()
    expect(iconFor(idle, undefined, true)).toEqual({ id: "circle-filled" })
    expect(iconFor(idle, undefined, false)).toEqual({ id: "circle-outline" })
  })

  it("fills the dot when there is no receipt at all", () => {
    // Unknown must not read as read: hiding new output is the worse failure.
    expect(iconFor(session(), undefined, undefined)).toEqual({ id: "circle-filled" })
  })

  it("keeps unread off every state that already asks a louder question", () => {
    // A spinner claiming novelty, or a ✗ going hollow because you read it,
    // would both be lies about a different axis.
    expect(iconFor(session({ busy: true }), undefined, true)).toEqual({ id: "loading~spin" })
    expect(iconFor(session({ status: "error" }), undefined, true)).toEqual({ id: "error", color: "error" })
    expect(iconFor(session({ status: "exited", exitCode: 0 }), undefined, false)).toEqual({ id: "check" })
    expect(iconFor(session({ awaitingInput: true }), undefined, false)).toEqual({
      id: "question",
      color: "warning",
    })
  })

  it("spins a starting session instead of parking it", () => {
    // Coming up is motion. `starting` isn't `busy`, so it fell through to the
    // idle dot and a booting adapter looked identical to an agent parked for
    // an hour — including the one the spawn wizard has just put on screen.
    expect(iconFor(session({ status: "starting" }))).toEqual({ id: "loading~spin" })
  })

  it("a finished session gets a check, not a prohibition sign", () => {
    // circle-slash (⊘) read "forbidden" on a session that did exactly its job.
    expect(iconFor(session({ status: "exited", exitCode: 0 }))).toEqual({ id: "check" })
  })

  it("⊘ now means what it looks like: you stopped this", () => {
    expect(iconFor(session({ status: "killed", exitCode: 143 }))).toEqual({ id: "circle-slash" })
  })

  it("keeps failure and attention loud", () => {
    expect(iconFor(session({ status: "error" }))).toEqual({ id: "error", color: "error" })
    expect(iconFor(session({ status: "exited", exitCode: 1 }))).toEqual({ id: "error", color: "error" })
    expect(iconFor(session({ awaitingInput: true }))).toEqual({ id: "question", color: "warning" })
    expect(iconFor(session({ awaitingPermission: true }))).toEqual({ id: "question", color: "warning" })
    expect(iconFor(session({ busy: true, awaitingInput: true }))).toEqual({
      id: "question",
      color: "warning",
    })
  })
})

describe("contextValueFor", () => {
  it("session-live for running, non-awaiting", () => {
    expect(contextValueFor(session())).toBe("session-live")
  })
  it("session-pending for an optimistic row, so no menu offers to act on it", () => {
    // Prompt/stop/restart against an id the daemon has never heard of can only
    // 404. The row exists to say "this is coming up", nothing more.
    expect(contextValueFor(session({ id: "pending:1", status: "starting" }))).toBe("session-pending")
  })
  it("session-awaiting when awaitingInput", () => {
    expect(contextValueFor(session({ awaitingInput: true }))).toBe("session-awaiting")
  })
  it("session-awaiting when awaitingPermission", () => {
    expect(contextValueFor(session({ awaitingPermission: true }))).toBe("session-awaiting")
  })
  it("session-done for exited/killed/error regardless of awaiting flags", () => {
    expect(contextValueFor(session({ status: "exited" }))).toBe("session-done")
    expect(contextValueFor(session({ status: "killed" }))).toBe("session-done")
    expect(contextValueFor(session({ status: "error" }))).toBe("session-done")
  })
})

describe("contextPercent", () => {
  it("rounds used/size to a percentage", () => {
    expect(contextPercent(50_000, 200_000)).toBe("25%")
  })
  it("returns undefined when either value is missing", () => {
    expect(contextPercent(undefined, 200_000)).toBeUndefined()
    expect(contextPercent(50_000, undefined)).toBeUndefined()
  })
  it("returns undefined for a zero/negative size", () => {
    expect(contextPercent(1, 0)).toBeUndefined()
  })
})

describe("tooltipFieldsFor", () => {
  it("always includes id, pid, startedAt", () => {
    const fields = tooltipFieldsFor(session())
    expect(fields).toEqual(
      expect.arrayContaining([
        { label: "id", value: "s1" },
        { label: "pid", value: "123" },
        { label: "startedAt", value: "2026-01-01T00:00:00Z" },
      ]),
    )
  })
  it("renders a null pid as an em dash", () => {
    const fields = tooltipFieldsFor(session({ pid: null }))
    expect(fields).toContainEqual({ label: "pid", value: "—" })
  })
  it("includes cwd only when set", () => {
    expect(tooltipFieldsFor(session({ cwd: undefined }))).not.toContainEqual(
      expect.objectContaining({ label: "cwd" }),
    )
    expect(tooltipFieldsFor(session({ cwd: "/tmp/x" }))).toContainEqual({ label: "cwd", value: "/tmp/x" })
  })
  it("formats cost to 4 decimal places", () => {
    expect(tooltipFieldsFor(session({ costUsd: 0.1 }))).toContainEqual({ label: "cost", value: "$0.1000" })
  })
  it("formats tokens in/out together, defaulting missing side to 0", () => {
    expect(tooltipFieldsFor(session({ tokensIn: 10 }))).toContainEqual({
      label: "tokens",
      value: "10 in / 0 out",
    })
  })
  it("formats context usage as a percent + raw fraction", () => {
    expect(tooltipFieldsFor(session({ contextUsed: 10, contextSize: 100 }))).toContainEqual({
      label: "context",
      value: "10% (10/100)",
    })
  })
  const hasBlockedOn = (s: SessionDescriptor): boolean =>
    tooltipFieldsFor(s).some(f => f.label === "blockedOn")

  it("includes blockedOn while the session is actually taking a turn", () => {
    expect(
      tooltipFieldsFor(session({ blockedOn: "subagent", status: "running", busy: true })),
    ).toContainEqual({ label: "blockedOn", value: "subagent" })
  })

  it("omits blockedOn when unset", () => {
    expect(hasBlockedOn(session())).toBe(false)
  })

  it("omits a stale blockedOn on a killed session — a dead session is blocked on nothing", () => {
    // Exactly the descriptor the daemon leaves behind when a session is killed
    // mid-tool-call: the turn's finally never runs, so busy/blockedOn survive
    // the kill. The tree must not repeat that claim.
    expect(hasBlockedOn(session({ status: "killed", busy: true, blockedOn: "command" }))).toBe(false)
  })

  it("omits blockedOn on a live but idle session", () => {
    expect(hasBlockedOn(session({ status: "running", busy: false, blockedOn: "command" }))).toBe(false)
  })
})

describe("compareSessions", () => {
  it("running sessions sort before terminal sessions", () => {
    const running = session({ id: "r", status: "running" })
    const done = session({ id: "d", status: "exited" })
    expect(compareSessions(running, done)).toBeLessThan(0)
    expect(compareSessions(done, running)).toBeGreaterThan(0)
  })
  it("within the same running-ness, sorts startedAt desc (newest first)", () => {
    const older = session({ id: "a", startedAt: "2026-01-01T00:00:00Z" })
    const newer = session({ id: "b", startedAt: "2026-01-02T00:00:00Z" })
    expect(compareSessions(newer, older)).toBeLessThan(0)
    expect(compareSessions(older, newer)).toBeGreaterThan(0)
  })
})

describe("buildSessionTree", () => {
  it("groups roots (no parentSessionId) at the top level", () => {
    const tree = buildSessionTree([session({ id: "a" }), session({ id: "b" })])
    expect(tree.map(n => n.session.id).sort()).toEqual(["a", "b"])
    expect(tree.every(n => n.children.length === 0)).toBe(true)
  })

  it("nests children under their parentSessionId", () => {
    const tree = buildSessionTree([
      session({ id: "parent", startedAt: "2026-01-01T00:00:00Z" }),
      session({ id: "child", parentSessionId: "parent", startedAt: "2026-01-01T01:00:00Z" }),
    ])
    expect(tree).toHaveLength(1)
    expect(tree[0]?.session.id).toBe("parent")
    expect(tree[0]?.children).toHaveLength(1)
    expect(tree[0]?.children[0]?.session.id).toBe("child")
  })

  it("treats a dangling parentSessionId (parent absent) as a root", () => {
    const tree = buildSessionTree([session({ id: "orphan", parentSessionId: "ghost" })])
    expect(tree.map(n => n.session.id)).toEqual(["orphan"])
  })

  it("sorts roots running-first then startedAt desc", () => {
    const tree = buildSessionTree([
      session({ id: "old-done", status: "exited", startedAt: "2026-01-01T00:00:00Z" }),
      session({ id: "new-running", status: "running", startedAt: "2026-01-01T00:00:00Z" }),
      session({ id: "newer-running", status: "running", startedAt: "2026-01-02T00:00:00Z" }),
      session({ id: "new-done", status: "exited", startedAt: "2026-01-03T00:00:00Z" }),
    ])
    expect(tree.map(n => n.session.id)).toEqual(["newer-running", "new-running", "new-done", "old-done"])
  })

  it("sorts a parent's children independently of siblings", () => {
    const tree = buildSessionTree([
      session({ id: "parent", startedAt: "2026-01-01T00:00:00Z" }),
      session({ id: "child-old", parentSessionId: "parent", startedAt: "2026-01-01T00:00:00Z" }),
      session({ id: "child-new", parentSessionId: "parent", startedAt: "2026-01-02T00:00:00Z" }),
    ])
    expect(tree[0]?.children.map(n => n.session.id)).toEqual(["child-new", "child-old"])
  })

  it("skips descriptors without an id", () => {
    const tree = buildSessionTree([{ ...session(), id: "" } as SessionDescriptor])
    expect(tree).toEqual([])
  })
})

describe("bucketFor", () => {
  const now = Date.parse("2026-01-10T00:00:00Z")

  it("recent for a session started within the last 24h", () => {
    expect(bucketFor(session({ startedAt: "2026-01-09T06:00:00Z" }), now)).toBe("recent")
  })
  it("older for a session started just over 24h ago", () => {
    expect(bucketFor(session({ startedAt: "2026-01-08T23:59:00Z" }), now)).toBe("older")
  })
  it("older for a session started days ago", () => {
    expect(bucketFor(session({ startedAt: "2026-01-02T00:00:00Z" }), now)).toBe("older")
  })
  it("older for an unparsable startedAt", () => {
    expect(bucketFor(session({ startedAt: "not-a-date" }), now)).toBe("older")
  })
})

describe("buildSessionRows", () => {
  const now = Date.parse("2026-01-10T00:00:00Z")

  const isSeparator = (n: TreeNode): n is SeparatorNode => "kind" in n && n.kind === "separator"
  /** Row ids top-to-bottom, with the divider rendered as "—". */
  const ids = (nodes: TreeNode[]): string[] =>
    nodes.map(n => (isSeparator(n) ? "—" : n.session.id))

  it("lists sessions flat with a single divider between recent and older", () => {
    const nodes = buildSessionRows(
      [
        session({ id: "recent", startedAt: "2026-01-09T12:00:00Z" }),
        session({ id: "stale", startedAt: "2025-12-01T00:00:00Z" }),
      ],
      now,
    )
    expect(ids(nodes)).toEqual(["recent", "—", "stale"])
    expect((nodes[1] as SeparatorNode).id).toBe(SEPARATOR_ID)
    expect((nodes[1] as SeparatorNode).label).toContain("older than 24h")
  })

  it("omits the divider when every session is recent — a rule with nothing below it separates nothing", () => {
    const nodes = buildSessionRows(
      [
        session({ id: "a", startedAt: "2026-01-09T12:00:00Z" }),
        session({ id: "b", startedAt: "2026-01-09T18:00:00Z" }),
      ],
      now,
    )
    expect(ids(nodes)).toEqual(["b", "a"])
  })

  it("omits the divider when every session is older", () => {
    const nodes = buildSessionRows(
      [
        session({ id: "a", startedAt: "2025-12-01T00:00:00Z" }),
        session({ id: "b", startedAt: "2025-11-01T00:00:00Z" }),
      ],
      now,
    )
    expect(ids(nodes)).toEqual(["a", "b"])
  })

  it("keeps an orchestrator subtree intact under its root (a child never migrates across the divider)", () => {
    const nodes = buildSessionRows(
      [
        session({ id: "parent", startedAt: "2026-01-09T12:00:00Z" }),
        session({ id: "child", parentSessionId: "parent", startedAt: "2025-01-01T00:00:00Z" }),
      ],
      now,
    )
    // The stale child stays nested under its recent parent — no divider, since
    // nothing sits at the top level on the older side.
    expect(ids(nodes)).toEqual(["parent"])
    const parent = nodes[0] as SessionNode
    expect(parent.children.map(n => n.session.id)).toEqual(["child"])
  })

  it("sorts running sessions above idle ones within the recent side", () => {
    const nodes = buildSessionRows(
      [
        session({ id: "idle", status: "exited", startedAt: "2026-01-09T20:00:00Z" }),
        session({ id: "live", status: "running", startedAt: "2026-01-09T01:00:00Z" }),
      ],
      now,
    )
    expect(ids(nodes)).toEqual(["live", "idle"])
  })

  it("returns no rows for an empty session list", () => {
    expect(buildSessionRows([], now)).toEqual([])
  })
})

describe("stall detection", () => {
  // The real descriptor from sess_be75fcdd: the agent emitted its last
  // text-delta + usage_update at 21:28 and never sent turn-end, so the daemon
  // still awaits a turn that will never finish and busy stays true forever.
  const stuck = (over: Partial<SessionDescriptor> = {}): SessionDescriptor =>
    session({
      status: "running",
      busy: true,
      lastActivityAt: "2026-07-15T21:28:27.011Z",
      lastOutputAt: "2026-07-15T21:28:27.002Z",
      ...over,
    })
  const now = Date.parse("2026-07-16T17:28:27.011Z") // exactly 20h after lastActivityAt

  it("reports the silence of a busy session", () => {
    expect(silentForMs(stuck(), now)).toBe(20 * 60 * 60 * 1000)
    expect(formatDuration(silentForMs(stuck(), now) ?? 0)).toBe("20h")
    expect(isStalled(stuck(), now)).toBe(true)
  })

  it("does not call a busy-but-chatty session stalled", () => {
    const live = stuck({ lastActivityAt: new Date(now - 5_000).toISOString() })
    expect(isStalled(live, now)).toBe(false)
  })

  it("gives a long tool call room — silence under the threshold is not a stall", () => {
    const building = stuck({ lastActivityAt: new Date(now - (STALL_AFTER_MS - 1_000)).toISOString() })
    expect(isStalled(building, now)).toBe(false)
  })

  it("repaints far more often than it takes to stall — silence must not need an unrelated event to surface", () => {
    // The tree renders every row against `now`, and the store only reports
    // sessions that CHANGED. A stall is the absence of change, so detection
    // rides entirely on this tick; if it were ever slower than the threshold,
    // a wedged session could sit unflagged for a full repaint period.
    expect(TREE_REPAINT_INTERVAL_MS).toBeLessThan(STALL_AFTER_MS)
    expect(TREE_REPAINT_INTERVAL_MS).toBeGreaterThan(0)
  })

  it("reports nothing for an idle or terminal session — only a turn can stall", () => {
    expect(silentForMs(stuck({ busy: false }), now)).toBeUndefined()
    expect(silentForMs(stuck({ status: "killed" }), now)).toBeUndefined()
    expect(isStalled(stuck({ status: "killed" }), now)).toBe(false)
  })

  it("falls back to lastOutputAt, and reports nothing when neither timestamp exists", () => {
    const noActivity = stuck({ lastActivityAt: undefined })
    expect(formatDuration(silentForMs(noActivity, now) ?? 0)).toBe("20h")
    expect(silentForMs(stuck({ lastActivityAt: undefined, lastOutputAt: undefined }), now)).toBeUndefined()
  })

  it("swaps the spinner for a warning — the spinner claiming a wedged session works IS the bug", () => {
    expect(iconFor(stuck(), now)).toEqual({ id: "warning", color: "warning" })
    // Without `now`, behavior is unchanged for existing call sites.
    expect(iconFor(stuck())).toEqual({ id: "loading~spin" })
    // A healthy busy session still spins.
    expect(iconFor(stuck({ lastActivityAt: new Date(now - 1_000).toISOString() }), now)).toEqual({
      id: "loading~spin",
    })
  })

  it("awaiting-input still outranks a stall — it needs the user, not a diagnosis", () => {
    expect(iconFor(stuck({ awaitingInput: true }), now)).toEqual({ id: "question", color: "warning" })
  })
})

describe("formatDuration", () => {
  it("scales the unit to the magnitude", () => {
    expect(formatDuration(45_000)).toBe("45s")
    expect(formatDuration(12 * 60_000)).toBe("12min")
    expect(formatDuration(3 * 3_600_000)).toBe("3h")
    expect(formatDuration(2 * 86_400_000)).toBe("2d")
  })
})
