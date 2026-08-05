import { describe, expect, it } from "vitest"

import type { SessionDescriptor, WorkspacesConfig } from "../client/types.js"
import {
  buildCreateWorkspaceCtas,
  buildOriginGroups,
  buildSessionsRoots,
  buildStatusGroups,
  buildWorkspaceGroups,
  collectGroupMembership,
  groupDescriptionFor,
  groupNodeId,
  isCtaNode,
  isGroupNode,
  isMachineOrigin,
  originGroupNodeId,
  originLabelFor,
  partitionSessionsByWorkspace,
  resolveOpenWorkspaceSlugs,
  sanitizeWorkspaceSlug,
  statusGroupNodeId,
  UNASSIGNED_LABEL,
  UNASSIGNED_SLUG,
  UNKNOWN_ORIGIN_SLUG,
  type GroupNode,
} from "./sessionsGroups.logic.js"
import { isSeparatorNode, type SessionNode } from "./sessionsTree.logic.js"

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
  workspaces: [
    { slug: "studio", path: "/Code/studio", addedAt: "", updatedAt: "", label: "Agentik Studio" },
    { slug: "guilde", path: "/Code/guilde", addedAt: "", updatedAt: "" },
  ],
}

const NOW = Date.parse("2026-01-02T00:00:00Z")

describe("partitionSessionsByWorkspace", () => {
  it("buckets a session by its cwd's longest-prefix workspace", () => {
    const sessions = [
      session({ id: "a", cwd: "/Code/studio/packages/vscode" }),
      session({ id: "b", cwd: "/Code/guilde" }),
    ]
    const { bySlug, unassigned } = partitionSessionsByWorkspace(sessions, config)
    expect(bySlug.get("studio")?.map(s => s.id)).toEqual(["a"])
    expect(bySlug.get("guilde")?.map(s => s.id)).toEqual(["b"])
    expect(unassigned).toEqual([])
  })

  it("puts a session with no cwd, or a cwd matching nothing, in unassigned", () => {
    const sessions = [
      session({ id: "no-cwd" }),
      session({ id: "elsewhere", cwd: "/Code/other-project" }),
    ]
    const { bySlug, unassigned } = partitionSessionsByWorkspace(sessions, config)
    expect(bySlug.size).toBe(0)
    expect(unassigned.map(s => s.id).sort()).toEqual(["elsewhere", "no-cwd"])
  })

  it("cwd wins over a mismatched workspaceSlug", () => {
    // workspaceSlug claims "studio" but cwd lives under "guilde" — cwd is authoritative.
    const sessions = [session({ id: "a", workspaceSlug: "studio", cwd: "/Code/guilde" })]
    const { bySlug, unassigned } = partitionSessionsByWorkspace(sessions, config)
    expect(bySlug.get("guilde")?.map(s => s.id)).toEqual(["a"])
    expect(unassigned).toEqual([])
  })

  it("falls back to workspaceSlug when cwd matches nothing", () => {
    // cwd is under a symlinked / containerised path that resolves to nothing,
    // but the session was spawned with an explicit workspaceSlug.
    const sessions = [session({ id: "a", workspaceSlug: "studio", cwd: "/Code/unregistered" })]
    const { bySlug, unassigned } = partitionSessionsByWorkspace(sessions, config)
    expect(bySlug.get("studio")?.map(s => s.id)).toEqual(["a"])
    expect(unassigned).toEqual([])
  })

  it("ignores the generic 'default' workspaceSlug fallback", () => {
    // The daemon uses "default" as a generic fallback — it carries no info.
    const sessions = [session({ id: "a", workspaceSlug: "default", cwd: "/Code/unregistered" })]
    const { bySlug, unassigned } = partitionSessionsByWorkspace(sessions, config)
    expect(bySlug.size).toBe(0)
    expect(unassigned.map(s => s.id)).toEqual(["a"])
  })
})

describe("resolveOpenWorkspaceSlugs", () => {
  it("resolves open folder paths to their registered workspace slugs", () => {
    const slugs = resolveOpenWorkspaceSlugs(config, ["/Code/studio/packages/vscode", "/Code/guilde"])
    expect(slugs).toEqual(new Set(["studio", "guilde"]))
  })

  it("skips an open folder matching no registered workspace", () => {
    const slugs = resolveOpenWorkspaceSlugs(config, ["/Code/unregistered"])
    expect(slugs.size).toBe(0)
  })
})

describe("sanitizeWorkspaceSlug", () => {
  it("lowercases, collapses non-conforming runs to a hyphen, trims edges", () => {
    expect(sanitizeWorkspaceSlug("My Cool Project!!")).toBe("my-cool-project")
  })
  it("falls back to 'workspace' for an entirely non-conforming input", () => {
    expect(sanitizeWorkspaceSlug("!!!")).toBe("workspace")
  })
  it("caps at 64 chars", () => {
    expect(sanitizeWorkspaceSlug("a".repeat(100)).length).toBe(64)
  })
})

describe("buildCreateWorkspaceCtas", () => {
  it("emits a CTA only for an open folder matching no registered workspace", () => {
    const ctas = buildCreateWorkspaceCtas(config, ["/Code/studio", "/Code/unregistered-project"])
    expect(ctas).toHaveLength(1)
    expect(ctas[0]?.folderPath).toBe("/Code/unregistered-project")
    expect(ctas[0]?.suggestedSlug).toBe("unregistered-project")
  })

  it("returns nothing when every open folder is already registered", () => {
    expect(buildCreateWorkspaceCtas(config, ["/Code/studio", "/Code/guilde"])).toEqual([])
  })

  it("returns nothing when no folder is open", () => {
    expect(buildCreateWorkspaceCtas(config, [])).toEqual([])
  })

  it("deduplicates a path passed more than once", () => {
    const ctas = buildCreateWorkspaceCtas(config, ["/Code/new-one", "/Code/new-one"])
    expect(ctas).toHaveLength(1)
  })
})

describe("groupDescriptionFor", () => {
  it("pluralizes", () => {
    expect(groupDescriptionFor(0)).toBe("0 sessions")
    expect(groupDescriptionFor(1)).toBe("1 session")
    expect(groupDescriptionFor(2)).toBe("2 sessions")
  })
})

describe("isGroupNode / isCtaNode", () => {
  it("discriminate by kind and reject non-node values", () => {
    const group: GroupNode = {
      kind: "group",
      id: groupNodeId("studio"),
      slug: "studio",
      label: "Agentik Studio",
      count: 0,
      isOpen: false,
      children: [],
    }
    expect(isGroupNode(group)).toBe(true)
    expect(isCtaNode(group)).toBe(false)
    expect(isGroupNode(undefined)).toBe(false)
    expect(isGroupNode(null)).toBe(false)
    expect(isGroupNode("group")).toBe(false)
  })
})

describe("buildWorkspaceGroups", () => {
  it("emits one group per registered workspace, even with zero sessions, by default", () => {
    const groups = buildWorkspaceGroups([], config, [], NOW)
    expect(groups.map(g => g.slug).sort()).toEqual(["guilde", "studio"])
    expect(groups.every(g => g.count === 0)).toBe(true)
  })

  it("counts every session landed in a group's bucket", () => {
    const sessions = [
      session({ id: "a", cwd: "/Code/studio" }),
      session({ id: "b", cwd: "/Code/studio/sub" }),
      session({ id: "c", cwd: "/Code/guilde" }),
    ]
    const groups = buildWorkspaceGroups(sessions, config, [], NOW)
    expect(groups.find(g => g.slug === "studio")?.count).toBe(2)
    expect(groups.find(g => g.slug === "guilde")?.count).toBe(1)
  })

  it("appends a trailing unassigned group only when a session matches nothing", () => {
    const withUnassigned = buildWorkspaceGroups([session({ cwd: "/Code/nowhere" })], config, [], NOW)
    expect(withUnassigned.at(-1)?.slug).toBe(UNASSIGNED_SLUG)
    expect(withUnassigned.at(-1)?.label).toBe(UNASSIGNED_LABEL)
    expect(withUnassigned.at(-1)?.count).toBe(1)

    const withoutUnassigned = buildWorkspaceGroups([], config, [], NOW)
    expect(withoutUnassigned.some(g => g.slug === UNASSIGNED_SLUG)).toBe(false)
  })

  it("marks the group matching an open folder isOpen and sorts it first", () => {
    const groups = buildWorkspaceGroups([], config, ["/Code/guilde"], NOW)
    expect(groups[0]?.slug).toBe("guilde")
    expect(groups[0]?.isOpen).toBe(true)
    expect(groups[1]?.isOpen).toBe(false)
  })

  it("sorts non-open groups alphabetically by label", () => {
    const threeWayConfig: WorkspacesConfig = {
      version: 1,
      workspaces: [
        { slug: "zeta", path: "/Code/zeta", addedAt: "", updatedAt: "", label: "Zeta" },
        { slug: "alpha", path: "/Code/alpha", addedAt: "", updatedAt: "", label: "Alpha" },
      ],
    }
    const groups = buildWorkspaceGroups([], threeWayConfig, [], NOW)
    expect(groups.map(g => g.label)).toEqual(["Alpha", "Zeta"])
  })

  it("label falls back to slug when no label is set", () => {
    const groups = buildWorkspaceGroups([], config, [], NOW)
    expect(groups.find(g => g.slug === "guilde")?.label).toBe("guilde")
  })

  it("hideEmpty drops zero-count groups (the active-filter behavior)", () => {
    const sessions = [session({ id: "a", cwd: "/Code/studio" })]
    const groups = buildWorkspaceGroups(sessions, config, [], NOW, { hideEmpty: true })
    expect(groups.map(g => g.slug)).toEqual(["studio"])
  })

  it("preserves the 24h-divider + parentSessionId nesting inside a group via buildSessionRows", () => {
    const sessions = [
      session({ id: "root", cwd: "/Code/studio", startedAt: "2026-01-01T23:00:00Z" }),
      session({ id: "child", cwd: "/Code/studio", parentSessionId: "root", startedAt: "2026-01-01T23:30:00Z" }),
    ]
    const group = buildWorkspaceGroups(sessions, config, [], NOW).find(g => g.slug === "studio")
    expect(group?.children).toHaveLength(1)
    const root = group?.children[0] as SessionNode
    expect(root.session.id).toBe("root")
    expect(root.children.map(c => c.session.id)).toEqual(["child"])
  })
})

describe("buildSessionsRoots (the grouping selector)", () => {
  const sessions = [session({ id: "a", cwd: "/Code/studio" })]

  it("grouping 'none' returns the plain flat rows — no GroupNode, no CTA", () => {
    const roots = buildSessionsRoots(sessions, config, ["/Code/unregistered"], NOW, {
      grouping: "none",
      filterActive: false,
    })
    expect(roots.some(isGroupNode)).toBe(false)
    expect(roots.some(isCtaNode)).toBe(false)
    expect(roots).toHaveLength(1)
  })

  it("grouping 'workspace' returns groups, with any CTA rows prepended first", () => {
    const roots = buildSessionsRoots(sessions, config, ["/Code/unregistered"], NOW, {
      grouping: "workspace",
      filterActive: false,
    })
    expect(isCtaNode(roots[0])).toBe(true)
    expect(roots.slice(1).every(isGroupNode)).toBe(true)
  })

  it("workspace mode never emits a CTA when every open folder is registered", () => {
    const roots = buildSessionsRoots(sessions, config, ["/Code/studio"], NOW, {
      grouping: "workspace",
      filterActive: false,
    })
    expect(roots.some(isCtaNode)).toBe(false)
  })

  it("grouping 'origin' buckets by source — GroupNodes only, no workspace CTA", () => {
    const originSessions = [
      session({ id: "a", cwd: "/Code/studio", origin: "vscode" }),
      session({ id: "b", cwd: "/Code/studio", origin: "claude-code" }),
    ]
    const roots = buildSessionsRoots(originSessions, config, ["/Code/unregistered"], NOW, {
      grouping: "origin",
      filterActive: false,
    })
    expect(roots.some(isCtaNode)).toBe(false)
    expect(roots.every(isGroupNode)).toBe(true)
    expect(roots.filter(isGroupNode).every(g => g.variant === "origin")).toBe(true)
  })
})

describe("buildOriginGroups", () => {
  it("buckets roots by origin with friendly labels", () => {
    const sessions = [
      session({ id: "a", origin: "claude-code" }),
      session({ id: "b", origin: "vscode" }),
    ]
    const groups = buildOriginGroups(sessions, NOW)
    const bySlug = new Map(groups.map(g => [g.slug, g]))
    expect(bySlug.get("claude-code")?.label).toBe("Claude Code (desktop)")
    expect(bySlug.get("vscode")?.label).toBe("VS Code extension")
    expect(bySlug.get("claude-code")?.id).toBe(originGroupNodeId("claude-code"))
    expect(groups.every(g => g.variant === "origin")).toBe(true)
  })

  it("nests a child under its ROOT's origin group, not its own", () => {
    const sessions = [
      session({ id: "root", origin: "vscode", startedAt: "2026-01-01T23:00:00Z" }),
      // child carries a different origin — must still land in the vscode bucket
      session({
        id: "child",
        origin: "claude-code",
        parentSessionId: "root",
        startedAt: "2026-01-01T23:30:00Z",
      }),
    ]
    const groups = buildOriginGroups(sessions, NOW)
    expect(groups.map(g => g.slug)).toEqual(["vscode"])
    expect(groups[0]?.count).toBe(2)
    const membership = collectGroupMembership(groups)
    expect(membership.get("root")).toBe(groups[0])
    expect(membership.get("child")).toBe(groups[0])
  })

  it("puts originless roots in the 'unknown' bucket, always sorted last", () => {
    const sessions = [
      session({ id: "a" }), // no origin
      session({ id: "b", origin: "vscode" }),
      session({ id: "c", origin: "cron" }),
    ]
    const groups = buildOriginGroups(sessions, NOW)
    expect(groups[groups.length - 1]?.slug).toBe(UNKNOWN_ORIGIN_SLUG)
    expect(originLabelFor(UNKNOWN_ORIGIN_SLUG)).toBe("Unknown source")
    // the known ones sort alphabetically by label ("Cron" before "VS Code…")
    expect(groups.slice(0, -1).map(g => g.slug)).toEqual(["cron", "vscode"])
  })

  it("renders an unknown origin under its raw slug (no code change needed)", () => {
    expect(originLabelFor("some-new-host")).toBe("some-new-host")
  })

  it("labels gate as a first-class, readable origin", () => {
    expect(originLabelFor("gate")).not.toBe("gate")
  })

  it("sorts machine-origin buckets after every human-origin bucket, before unknown", () => {
    const sessions = [
      session({ id: "z", origin: "vscode" }),
      session({ id: "g", origin: "gate" }),
      session({ id: "a", origin: "claude-code" }),
      session({ id: "u" }), // no origin -> unknown
    ]
    const groups = buildOriginGroups(sessions, NOW)
    expect(groups.map(g => g.slug)).toEqual(["claude-code", "vscode", "gate", UNKNOWN_ORIGIN_SLUG])
  })
})

describe("isMachineOrigin", () => {
  it("is true for gate, false for a human origin, undefined, or an unrecognized slug", () => {
    expect(isMachineOrigin("gate")).toBe(true)
    expect(isMachineOrigin("claude-code")).toBe(false)
    expect(isMachineOrigin("vscode")).toBe(false)
    expect(isMachineOrigin(undefined)).toBe(false)
    expect(isMachineOrigin("some-new-host")).toBe(false)
  })
})

describe("buildStatusGroups", () => {
  it("buckets by status category, attention-first (awaiting/live/failed/stopped/done)", () => {
    const sessions = [
      session({ id: "d", status: "exited" }), // done
      session({ id: "r", status: "running" }), // live
      session({ id: "e", status: "error" }), // failed
    ]
    const groups = buildStatusGroups(sessions, NOW)
    // present categories, in STATUS_CATEGORY_ORDER: live, failed, done
    expect(groups.map(g => g.slug)).toEqual(["live", "failed", "done"])
    expect(groups.every(g => g.variant === "status")).toBe(true)
    expect(groups[0]?.label).toBe("Live")
    expect(groups.find(g => g.slug === "done")?.id).toBe(statusGroupNodeId("done"))
  })

  it("omits empty categories", () => {
    const groups = buildStatusGroups([session({ id: "r", status: "running" })], NOW)
    expect(groups.map(g => g.slug)).toEqual(["live"])
  })

  it("nests a child under its ROOT's status group, not its own", () => {
    const sessions = [
      session({ id: "root", status: "running", startedAt: "2026-01-01T23:00:00Z" }), // live
      session({
        id: "child",
        status: "exited", // done on its own, but must follow the root into 'live'
        parentSessionId: "root",
        startedAt: "2026-01-01T23:30:00Z",
      }),
    ]
    const groups = buildStatusGroups(sessions, NOW)
    expect(groups.map(g => g.slug)).toEqual(["live"])
    expect(groups[0]?.count).toBe(2)
    const membership = collectGroupMembership(groups)
    expect(membership.get("root")).toBe(groups[0])
    expect(membership.get("child")).toBe(groups[0])
  })
})

describe("collectGroupMembership", () => {
  it("maps every session id (root and nested) to its containing GroupNode", () => {
    const sessions = [
      session({ id: "root", cwd: "/Code/studio", startedAt: "2026-01-01T23:00:00Z" }),
      session({ id: "child", cwd: "/Code/studio", parentSessionId: "root", startedAt: "2026-01-01T23:30:00Z" }),
    ]
    const groups = buildWorkspaceGroups(sessions, config, [], NOW)
    const membership = collectGroupMembership(groups)
    const studio = groups.find(g => g.slug === "studio")
    expect(membership.get("root")).toBe(studio)
    expect(membership.get("child")).toBe(studio)
    expect(membership.has("nonexistent")).toBe(false)
  })

  it("never maps a separator row (isSeparatorNode guards it out)", () => {
    // Two sessions on opposite sides of the 24h divider forces a separator
    // into the group's children — membership must skip it, not throw.
    const sessions = [
      session({ id: "recent", cwd: "/Code/studio", startedAt: "2026-01-01T23:00:00Z" }),
      session({ id: "old", cwd: "/Code/studio", startedAt: "2025-01-01T00:00:00Z" }),
    ]
    const groups = buildWorkspaceGroups(sessions, config, [], NOW)
    const studio = groups.find(g => g.slug === "studio")
    expect(studio?.children.some(isSeparatorNode)).toBe(true)
    const membership = collectGroupMembership(groups)
    expect(membership.get("recent")).toBe(studio)
    expect(membership.get("old")).toBe(studio)
  })
})
