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
  pr:
    | null
    | { state: string; number?: number }
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

/** Injected port: the runtime asks the host to list worktrees for a repo. */
export type WorktreeStatusLister = (repoRoot: string) => Promise<WorktreeStatusView[]>

interface IntegrationLike {
  state: string
  pr?: number
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
  class: WorktreeStatusView["class"]
  reclaimable: boolean
  integration: IntegrationLike
  liveness: LivenessLike
  provenance: ProvenanceLike
}

/**
 * Pure projection from a raw `WorktreeStatusEntry` to the view the daemon
 * surfaces. Kept in one place so the MCP tool and HTTP route cannot drift.
 */
export function toWorktreeStatusView(entry: unknown): WorktreeStatusView {
  const e = entry as WorktreeStatusEntryLike
  return {
    path: e.path,
    branch: e.branch,
    class: e.class,
    reclaimable: e.reclaimable,
    pr: derivePr(e.integration),
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

function derivePr(integration: IntegrationLike): WorktreeStatusView["pr"] {
  if (integration.state === "open") {
    return { state: "open", number: integration.pr }
  }
  if (integration.state === "merged") {
    return { state: "merged" }
  }
  return { state: integration.state }
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
