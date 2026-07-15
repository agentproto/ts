/**
 * Pure workspace-resolution helpers — NO vscode import, no I/O.
 *
 * Why this exists: a SessionDescriptor carries only `workspaceSlug`, never a
 * display name, and that slug is unreliable as an attribution key — it
 * silently defaults to "default" on every spawn path except
 * POST /sessions/agent (the only one that reverse-maps cwd → slug daemon-side
 * via findWorkspaceByPath; see runtime/src/session-spawn.ts). A terminal
 * spawned with an explicit cwd *inside* a registered workspace still lands in
 * "default".
 *
 * So the extension does the join itself:
 *   - `workspaceLabelFor` renders a name for the tree.
 *   - `findWorkspaceByPath` re-implements the daemon's own longest-prefix rule
 *     (runtime/src/workspaces-config.ts:202) so spawn can send an explicit,
 *     correct `workspaceSlug` rather than trusting the daemon to infer it.
 *
 * Keep the longest-prefix rule byte-identical to the daemon's: most specific
 * (longest registered path) wins, exact match counts, and a prefix only
 * matches on a path-segment boundary ("/a/bc" must NOT match workspace "/a/b").
 */

import type { SessionDescriptor, WorkspaceEntry, WorkspacesConfig } from "../client/types.js"

/** An empty config — safe default when GET /workspaces is unreachable. */
export const EMPTY_WORKSPACES: WorkspacesConfig = { version: 1, workspaces: [] }

/**
 * Normalize a path for prefix comparison: strip trailing slashes so
 * "/a/b/" and "/a/b" compare equal. Does not resolve symlinks or "..";
 * the daemon uses node:path.resolve, and both sides are already absolute
 * paths produced by the same OS.
 */
function normalizePath(p: string): string {
  const trimmed = p.replace(/\/+$/, "")
  return trimmed === "" ? "/" : trimmed
}

/** True when `dir` is the workspace root itself or lives beneath it. */
function isUnder(dir: string, root: string): boolean {
  const d = normalizePath(dir)
  const r = normalizePath(root)
  if (d === r) return true
  // Segment-boundary guard: "/a/bc" must not match root "/a/b".
  return d.startsWith(r === "/" ? "/" : `${r}/`)
}

/**
 * Longest-prefix match of `dir` against the registered workspaces — the
 * daemon's own rule (workspaces-config.ts:202-211). Returns undefined when
 * the path belongs to no registered workspace.
 */
export function findWorkspaceByPath(
  config: WorkspacesConfig,
  dir: string,
): WorkspaceEntry | undefined {
  if (!dir) return undefined
  const candidates = config.workspaces
    .filter(w => isUnder(dir, w.path))
    .sort((a, b) => normalizePath(b.path).length - normalizePath(a.path).length)
  return candidates[0]
}

/** Display name for a slug: the entry's label, else the slug itself. */
export function workspaceLabel(config: WorkspacesConfig, slug: string): string {
  const entry = config.workspaces.find(w => w.slug === slug)
  return entry?.label ?? slug
}

/**
 * Best display name for a session's workspace.
 *
 * Resolution order, deliberately preferring cwd over the descriptor's slug:
 *   1. cwd → longest-prefix registered workspace (authoritative — this is what
 *      the user means by "which project is this session in").
 *   2. the descriptor's own `workspaceSlug`, joined to a label when known.
 *   3. undefined when the session has neither (nothing to render).
 *
 * Why cwd first: a terminal session's `workspaceSlug` is "default" even when
 * its cwd sits inside a registered workspace, so trusting the slug would file
 * real project sessions under a bogus "default" bucket. Once the daemon fixes
 * the spawn-path asymmetry, the two agree and the order stops mattering.
 */
export function workspaceLabelFor(
  config: WorkspacesConfig,
  session: Pick<SessionDescriptor, "cwd" | "workspaceSlug">,
): string | undefined {
  if (session.cwd) {
    const byPath = findWorkspaceByPath(config, session.cwd)
    if (byPath) return byPath.label ?? byPath.slug
  }
  const slug = session.workspaceSlug
  if (!slug) return undefined
  if (slug === "default" && session.cwd) {
    // An unattributed session whose cwd matched nothing registered — showing
    // "default" is noise, so let the caller omit the field entirely.
    return undefined
  }
  return workspaceLabel(config, slug)
}

/**
 * Every distinct workspace label present in a session list, sorted, for the
 * filter picker. Sessions with no resolvable workspace are excluded.
 */
export function workspaceLabelsIn(
  config: WorkspacesConfig,
  sessions: readonly Pick<SessionDescriptor, "cwd" | "workspaceSlug">[],
): string[] {
  const labels = new Set<string>()
  for (const s of sessions) {
    const label = workspaceLabelFor(config, s)
    if (label) labels.add(label)
  }
  return [...labels].sort((a, b) => a.localeCompare(b))
}
