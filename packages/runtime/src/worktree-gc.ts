/**
 * Shared kernel for the daemon's worktree-`gc` surface — the transport twin of
 * `worktree-status.ts`. The `gc` engine itself (`planGc` / `applyGc`, with all
 * of its merge-gated-reclaim / open-PR-is-hold / dirty-is-salvage-only safety
 * layers) lives in `@agentproto/worktree`, a dependency the runtime
 * deliberately does NOT take (see `worktree-isolation.ts`). So — exactly as the
 * status surface does — the runtime only defines:
 *   - runtime-local structural result types (the dry-run plan AND the apply
 *     outcomes), so no gc type is imported into the runtime
 *   - the injected `WorktreeGcRunner` port
 *
 * The CLI host wires the real runner (it has access to `@agentproto/worktree`).
 * Repo-root resolution is shared with the status surface via
 * `resolveWorktreeQueryRoot` in `worktree-status.ts`.
 */

/** `gc`'s three classes, mirrored runtime-local (matches `GcClass`). */
export type WorktreeGcClass = "reclaim" | "salvage" | "hold"

/**
 * `gc`'s reclaim reasons, mirrored runtime-local (matches `GcReclaimReason`).
 * `dep-bump` is set on a `reclaim`-class entry/outcome that was promoted out
 * of `hold` by the dep-bump exemption (`resolveGcClass` in
 * `@agentproto/worktree`) — absent for an ordinary merged/fresh reclaim, so
 * its presence alone is the "why does this line have unpushed commits and
 * still leave" signal a human reading the plan/outcome table needs.
 * `orphan` is set on an entry/outcome the orphan scan found — a directory
 * physically present under the repo's worktree pool with no `git worktree
 * list` entry at all (see `WorktreeGcPlanEntryView.orphan`).
 */
export type WorktreeGcReclaimReason = "dep-bump" | "orphan"

/**
 * One entry of the dry-run plan — a runtime-local projection of a
 * `GcPlanEntry`. `tree` / `integration` / `liveness` are flattened to their
 * discriminant `state` (plus the PR number when the integration carries one)
 * so the runtime never depends on the gc engine's richer state objects.
 */
export interface WorktreeGcPlanEntryView {
  path: string
  branch: string | null
  head: string
  class: WorktreeGcClass
  /** Set only when `class === "reclaim"` via the dep-bump exemption or the orphan scan. */
  reclaimReason?: WorktreeGcReclaimReason
  /**
   * `true` only for an orphan-scan entry: a directory physically present
   * under the repo's worktree pool with no `git worktree list` entry at all
   * (even after a prune). `tree`/`integration`/`liveness` carry no real axis
   * read for these — git itself can't answer those questions for a
   * directory it no longer recognizes as a worktree — so they're set to the
   * literal `"orphan"` placeholder below rather than a fabricated value.
   */
  orphan?: boolean
  tree: string
  integration: { state: string; pr?: number }
  liveness: { state: string; sessionCount: number }
}

/**
 * One outcome of an apply run — a runtime-local projection of a
 * `GcApplyOutcome`. Every discriminant `result` the engine can emit is
 * preserved; the extra fields (`salvageDir`, `from`/`to`, `message`) are
 * present only for the results that carry them, exactly as the engine's
 * discriminated union has them.
 */
export interface WorktreeGcOutcomeView {
  path: string
  branch: string | null
  result:
    | "reclaimed"
    | "salvaged"
    | "held"
    | "skipped-dirty"
    | "aborted-reclassified"
    | "aborted-vanished"
    | "failed"
  /** Set only for a `reclaimed` outcome via the dep-bump exemption. */
  reclaimReason?: WorktreeGcReclaimReason
  /** Set only for `salvaged`. */
  salvageDir?: string
  /** Set only for `aborted-reclassified`. */
  from?: WorktreeGcClass
  /** Set only for `aborted-reclassified`. */
  to?: WorktreeGcClass
  /** Set only for `failed`. */
  message?: string
}

/**
 * The runner's result — a dry run returns the plan, an apply returns the
 * outcomes. The `mode` discriminant lets the tool/route render either without
 * a second call and without importing gc types.
 */
export type WorktreeGcResult =
  | { mode: "plan"; plan: WorktreeGcPlanEntryView[] }
  | { mode: "apply"; outcomes: WorktreeGcOutcomeView[] }

/** Input to the injected runner. `apply` defaults to false at the tool/route
 *  boundary — a bare call is a dry run. */
export interface WorktreeGcRunInput {
  repoRoot: string
  apply: boolean
  salvageDirty: boolean
  includeDetached: boolean
}

/**
 * Injected port: the runtime asks the host to plan (and, when `apply`, execute)
 * a `gc` sweep for a repo. The host is responsible for resolving `repoRoot`
 * onto the true git repo root (e.g. via `repoRootOf`), just like the status
 * lister.
 */
export type WorktreeGcRunner = (input: WorktreeGcRunInput) => Promise<WorktreeGcResult>
