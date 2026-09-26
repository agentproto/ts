/**
 * Shared kernel for the daemon's worktree-status query surface.
 *
 * The heavy join itself (`listWorktreeStatuses`) lives in
 * `@agentproto/worktree`, a dependency the runtime deliberately does NOT take
 * (see `worktree-isolation.ts`). So the runtime only defines:
 *   - the VSCode-friendly view type
 *   - the pure projection from a raw `WorktreeStatusEntry`-shaped object
 *   - workspace→repo-root resolution for tool/route inputs
 *   - the injected `WorktreeStatusLister` port
 *
 * The CLI host wires the real lister (it has access to both
 * `@agentproto/worktree` and this module's `toWorktreeStatusView`).
 */

import {
  loadWorkspacesConfig,
  findWorkspace,
  getActiveWorkspace,
} from "./workspaces-config.js"

/** Trimmed, VSCode-friendly projection of one worktree status. */
export interface WorktreeStatusView {
  path: string
  branch: string | null
  class: "reclaim" | "salvage" | "hold"
  reclaimable: boolean
  /** Uncommitted work in the tree (modified, staged or untracked paths). */
  dirty: boolean
  /** Per-kind counts, present only when `dirty`. */
  changes?: { modified: number; staged: number; untracked: number }
  /** Ahead/behind vs the base ref the integration check compares against
   *  (the repo's default branch, e.g. `origin/main`). `null` for a detached
   *  tip or when git couldn't resolve the base. */
  base: null | { ref: string; ahead: number; behind: number }
  /** Integration state; `number` whenever the forge matched a PR (open,
   *  merged, partial), `url` when the host knows the forge's web URL. */
  pr:
    | null
    | { state: string; number?: number; url?: string }
  sessions: Array<{
    id: string
    adapterSlug?: string
    model?: string
    status: string
    startedAt: string
  }>
  liveness: {
    state: string
    sessionCount: number
  }
}

/** Narrows a lister call. `paths` computes only those worktrees (compared
 *  resolved) instead of every worktree of the repo: one forge round-trip for
 *  a per-session lookup, not one per worktree. */
export interface WorktreeStatusListOptions {
  paths?: readonly string[]
}

/** Injected port: the runtime asks the host to list worktrees for a repo. */
export type WorktreeStatusLister = (
  repoRoot: string,
  options?: WorktreeStatusListOptions,
) => Promise<WorktreeStatusView[]>

interface IntegrationLike {
  state: string
  pr?: number
}

interface TreeLike {
  state: string
  modified?: number
  staged?: number
  untracked?: number
}

interface BaseLike {
  ref: string
  ahead: number
  behind: number
}

interface LivenessLike {
  state: string
  sessions: unknown[]
}

interface ProvenanceSessionLike {
  id: string
  adapterSlug?: string
  model?: string
  status: string
  startedAt: string
}

interface ProvenanceLike {
  sessions: ProvenanceSessionLike[]
}

interface WorktreeStatusEntryLike {
  path: string
  branch: string | null
  tree?: TreeLike
  base?: BaseLike | null
  class: WorktreeStatusView["class"]
  reclaimable: boolean
  integration: IntegrationLike
  liveness: LivenessLike
  provenance: ProvenanceLike
}

export interface ToWorktreeStatusViewOptions {
  /** Web URL of PR `number` on this repo's forge, when the host can build
   *  one (e.g. from a GitHub `origin` remote). */
  prUrl?: (number: number) => string | undefined
}

/**
 * Pure projection from a raw `WorktreeStatusEntry` to the view the daemon
 * surfaces. Kept in one place so the MCP tool and HTTP route cannot drift.
 */
export function toWorktreeStatusView(
  entry: unknown,
  options: ToWorktreeStatusViewOptions = {},
): WorktreeStatusView {
  const e = entry as WorktreeStatusEntryLike
  const dirty = e.tree?.state === "dirty"
  return {
    path: e.path,
    branch: e.branch,
    class: e.class,
    reclaimable: e.reclaimable,
    dirty,
    ...(dirty
      ? {
          changes: {
            modified: e.tree?.modified ?? 0,
            staged: e.tree?.staged ?? 0,
            untracked: e.tree?.untracked ?? 0,
          },
        }
      : {}),
    base: e.base ? { ref: e.base.ref, ahead: e.base.ahead, behind: e.base.behind } : null,
    pr: derivePr(e.integration, options.prUrl),
    sessions: e.provenance.sessions.map(s => ({
      id: s.id,
      ...(s.adapterSlug !== undefined ? { adapterSlug: s.adapterSlug } : {}),
      ...(s.model !== undefined ? { model: s.model } : {}),
      status: s.status,
      startedAt: s.startedAt,
    })),
    liveness: {
      state: e.liveness.state,
      sessionCount: e.liveness.sessions.length,
    },
  }
}

function derivePr(
  integration: IntegrationLike,
  prUrl?: (number: number) => string | undefined,
): WorktreeStatusView["pr"] {
  const number = typeof integration.pr === "number" ? integration.pr : undefined
  if (number === undefined) return { state: integration.state }
  const url = prUrl?.(number)
  return { state: integration.state, number, ...(url ? { url } : {}) }
}

/**
 * Resolve the repo root a `worktree_status` query should target.
 *
 * Precedence:
 *   1. Explicit `repoRoot` (passed through as-is).
 *   2. Explicit `workspaceSlug` → lookup in `~/.agentproto/workspaces.json`.
 *   3. Neither → active workspace.
 *
 * The returned path is a *candidate*: the injected lister is responsible for
 * resolving it onto the true git repo root (e.g. via `repoRootOf`).
 */
export async function resolveWorktreeQueryRoot(input: {
  repoRoot?: string | undefined
  workspaceSlug?: string | undefined
}): Promise<
  | { ok: true; repoRoot: string }
  | { ok: false; error: string; status: number }
> {
  if (input.repoRoot) {
    return { ok: true, repoRoot: input.repoRoot }
  }

  let config
  try {
    config = await loadWorkspacesConfig()
  } catch (err) {
    return {
      ok: false,
      error: `workspaces_load_failed: ${err instanceof Error ? err.message : String(err)}`,
      status: 500,
    }
  }

  const ws = input.workspaceSlug
    ? findWorkspace(config, input.workspaceSlug)
    : getActiveWorkspace(config)

  if (!ws) {
    return {
      ok: false,
      error: input.workspaceSlug
        ? `workspace_not_found: "${input.workspaceSlug}" is not registered`
        : "no_active_workspace: add one with `agentproto workspace add`",
      status: 404,
    }
  }

  return { ok: true, repoRoot: ws.path }
}

/**
 * Where a per-session `worktree_status` read points: the session's own
 * `worktreePath`, listed against its `mainRepoPath` (the primary checkout,
 * recorded at spawn) when known, else against the worktree path itself,
 * which the host's lister resolves onto the repo. `null` when the session
 * isn't in a linked worktree.
 */
export function sessionWorktreeScope(desc: {
  worktreePath?: string
  mainRepoPath?: string
}): { repoRoot: string; worktreePath: string } | null {
  if (!desc.worktreePath) return null
  return {
    repoRoot: desc.mainRepoPath ?? desc.worktreePath,
    worktreePath: desc.worktreePath,
  }
}
