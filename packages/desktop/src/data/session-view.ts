// Pure derivations from a live SessionDescriptor to the display shape the mock
// renders: a status kind (run/input/perm/idle), a human status line, a title,
// and the workspace-grouped + parent-nested tree the rail walks.

import type { SessionDescriptor } from "./types"

/** The four rail/header status kinds, mirroring the mock's dot classes. */
export type StatusKind = "run" | "input" | "perm" | "idle"

/** Collapse a descriptor's many boolean/enum flags into one status kind, in the
 *  mock's precedence: permission > input > running > idle. */
export function statusKind(s: SessionDescriptor): StatusKind {
  if (s.awaitingPermission) return "perm"
  if (s.awaitingInput || s.awaitingQuestion) return "input"
  if (s.busy || s.status === "running" || s.status === "starting") return "run"
  return "idle"
}

/** The status pill's text — "running · turn N", "awaiting permission", etc. */
export function statusText(s: SessionDescriptor): string {
  switch (statusKind(s)) {
    case "perm":
      return "awaiting permission"
    case "input":
      return "awaiting your input"
    case "run": {
      const turn = s.turnsCompleted
      return typeof turn === "number" && turn > 0 ? `running · turn ${turn + 1}` : "running"
    }
    case "idle":
      if (s.status === "exited") {
        return typeof s.exitCode === "number" ? `exited · exit ${s.exitCode}` : "exited"
      }
      if (s.status === "killed") return "killed"
      if (s.status === "error") return "error"
      return s.status
  }
}

/** Best display title, in the daemon's own fallback order. */
export function sessionTitle(s: SessionDescriptor): string {
  return s.title || s.label || s.name || s.command || s.id
}

/** A session paired with its nested children (one level, by parentSessionId). */
export interface SessionNode {
  session: SessionDescriptor
  children: SessionDescriptor[]
}

/** A workspace bucket: its slug/label and the ordered top-level session nodes. */
export interface WorkspaceGroup {
  slug: string
  label: string
  nodes: SessionNode[]
  /** Total sessions in the group (parents + children), for the count badge. */
  count: number
  /** True when any session in the group is non-idle. */
  live: boolean
}

/**
 * Group sessions by workspaceSlug (first-seen order), and within each group
 * nest children under their parent (by parentSessionId, when the parent is in
 * the same list). A child whose parent is absent is promoted to top level so it
 * is never dropped.
 */
export function groupSessions(sessions: readonly SessionDescriptor[]): WorkspaceGroup[] {
  const byId = new Map<string, SessionDescriptor>()
  for (const s of sessions) byId.set(s.id, s)

  const childrenOf = new Map<string, SessionDescriptor[]>()
  const topLevel: SessionDescriptor[] = []
  for (const s of sessions) {
    const parent = s.parentSessionId
    if (parent && byId.has(parent)) {
      const list = childrenOf.get(parent) ?? []
      list.push(s)
      childrenOf.set(parent, list)
    } else {
      topLevel.push(s)
    }
  }

  const groups = new Map<string, WorkspaceGroup>()
  const order: string[] = []
  for (const s of topLevel) {
    const slug = s.workspaceSlug || "default"
    let group = groups.get(slug)
    if (!group) {
      group = { slug, label: slug, nodes: [], count: 0, live: false }
      groups.set(slug, group)
      order.push(slug)
    }
    const children = childrenOf.get(s.id) ?? []
    group.nodes.push({ session: s, children })
    group.count += 1 + children.length
    if (statusKind(s) !== "idle" || children.some((c) => statusKind(c) !== "idle")) {
      group.live = true
    }
  }
  return order.map((slug) => {
    const group = groups.get(slug)
    if (!group) throw new Error(`workspace group ${slug} missing`)
    return group
  })
}
