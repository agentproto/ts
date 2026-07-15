import { describe, expect, it } from "vitest"

import type { SessionDescriptor } from "../client/types.js"
import {
  bucketFor,
  buildBucketedTree,
  buildSessionTree,
  compareSessions,
  contextValueFor,
  contextPercent,
  descriptionFor,
  iconFor,
  labelFor,
  relativeTime,
  tooltipFieldsFor,
  type BucketNode,
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

    it("renders workspace · token delta · relative time", () => {
      const s = session({
        startedAt: "2026-01-01T00:00:00Z",
        tokensIn: 120,
        tokensOut: 45,
      })
      expect(descriptionFor(s, { workspaceLabel: "Agentik Studio", now })).toBe(
        "Agentik Studio · +120 -45 · 5 days ago",
      )
    })
    it("omits workspace when unset", () => {
      const s = session({ startedAt: "2026-01-01T00:00:00Z", tokensIn: 10, tokensOut: 5 })
      expect(descriptionFor(s, { now })).toBe("+10 -5 · 5 days ago")
    })
    it("omits the token part when BOTH tokensIn/tokensOut are absent (never a bare +0 -0)", () => {
      const s = session({ startedAt: "2026-01-01T00:00:00Z" })
      expect(descriptionFor(s, { workspaceLabel: "ws", now })).toBe("ws · 5 days ago")
    })
    it("defaults a missing side to 0 when at least one token field is present", () => {
      const s = session({ startedAt: "2026-01-01T00:00:00Z", tokensIn: 10 })
      expect(descriptionFor(s, { now })).toBe("+10 -0 · 5 days ago")
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

describe("iconFor", () => {
  it("busy -> sync~spin", () => {
    expect(iconFor(session({ busy: true }))).toEqual({ id: "sync~spin" })
  })
  it("awaitingInput -> question (warning)", () => {
    expect(iconFor(session({ awaitingInput: true }))).toEqual({ id: "question", color: "warning" })
  })
  it("awaitingPermission -> question (warning)", () => {
    expect(iconFor(session({ awaitingPermission: true }))).toEqual({ id: "question", color: "warning" })
  })
  it("running idle -> play", () => {
    expect(iconFor(session())).toEqual({ id: "play" })
  })
  it("exited cleanly -> circle-slash", () => {
    expect(iconFor(session({ status: "exited", exitCode: 0 }))).toEqual({ id: "circle-slash" })
  })
  it("killed -> circle-slash", () => {
    expect(iconFor(session({ status: "killed" }))).toEqual({ id: "circle-slash" })
  })
  it("status error -> error", () => {
    expect(iconFor(session({ status: "error" }))).toEqual({ id: "error", color: "error" })
  })
  it("exitCode > 0 -> error even if status is exited", () => {
    expect(iconFor(session({ status: "exited", exitCode: 1 }))).toEqual({ id: "error", color: "error" })
  })
  it("awaiting takes priority over busy", () => {
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
  it("includes blockedOn only when set", () => {
    expect(tooltipFieldsFor(session({ blockedOn: "subagent" }))).toContainEqual({
      label: "blockedOn",
      value: "subagent",
    })
    expect(tooltipFieldsFor(session())).not.toContainEqual(expect.objectContaining({ label: "blockedOn" }))
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

  it("last7days for a session started within the last 7×24h", () => {
    expect(bucketFor(session({ startedAt: "2026-01-08T00:00:00Z" }), now)).toBe("last7days")
  })
  it("older for a session started 7+ days ago", () => {
    expect(bucketFor(session({ startedAt: "2026-01-02T00:00:00Z" }), now)).toBe("older")
  })
  it("older for an unparsable startedAt", () => {
    expect(bucketFor(session({ startedAt: "not-a-date" }), now)).toBe("older")
  })
})

describe("buildBucketedTree", () => {
  const now = Date.parse("2026-01-10T00:00:00Z")

  it("groups top-level roots into bucket nodes, newest bucket first", () => {
    const nodes = buildBucketedTree(
      [
        session({ id: "recent", startedAt: "2026-01-09T00:00:00Z" }),
        session({ id: "stale", startedAt: "2025-12-01T00:00:00Z" }),
      ],
      now,
    )
    expect(nodes.map(n => (n as BucketNode).bucket)).toEqual(["last7days", "older"])
    expect(nodes.map(n => (n as BucketNode).label)).toEqual(["LAST 7 DAYS", "OLDER"])
    expect((nodes[0] as BucketNode).children.map(n => n.session.id)).toEqual(["recent"])
    expect((nodes[1] as BucketNode).children.map(n => n.session.id)).toEqual(["stale"])
  })

  it("omits an empty bucket entirely", () => {
    const nodes = buildBucketedTree([session({ id: "recent", startedAt: "2026-01-09T00:00:00Z" })], now)
    expect(nodes).toHaveLength(1)
    expect((nodes[0] as BucketNode).bucket).toBe("last7days")
  })

  it("keeps an orchestrator subtree intact inside its root's bucket (children never migrate)", () => {
    const nodes = buildBucketedTree(
      [
        session({ id: "parent", startedAt: "2026-01-09T00:00:00Z" }),
        session({ id: "child", parentSessionId: "parent", startedAt: "2025-01-01T00:00:00Z" }),
      ],
      now,
    )
    expect(nodes).toHaveLength(1)
    const bucket = nodes[0] as BucketNode
    expect(bucket.bucket).toBe("last7days")
    expect(bucket.children).toHaveLength(1)
    expect(bucket.children[0]?.session.id).toBe("parent")
    expect(bucket.children[0]?.children.map(n => n.session.id)).toEqual(["child"])
  })

  it("returns no nodes for an empty session list", () => {
    expect(buildBucketedTree([], now)).toEqual([])
  })
})
