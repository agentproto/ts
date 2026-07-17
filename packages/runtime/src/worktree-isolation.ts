/**
 * Policy layer for `agent_start.worktree` — the config-driven decision of
 * WHETHER to isolate a spawn into its own git worktree, kept deliberately
 * separate from HOW one is provisioned.
 *
 * This module holds no dependency on `@agentproto/worktree`. Same reasoning
 * as `worktree-identity.ts`'s docblock, only stronger: provisioning runs the
 * `worktree.provision` TOOL (git + the base tree's `agentproto.json` setup
 * hooks), which would drag the driver/harness/provider graph into
 * `@agentproto/runtime` for a capability the runtime only ever *triggers*.
 * So the concrete provisioner is an INJECTED PORT ({@link WorktreeProvisioner})
 * wired at the composition root by a host that already depends on the
 * worktree package (the CLI). The runtime owns only the pure decision
 * ({@link decideWorktreeIsolation}) and the config/env resolution
 * ({@link loadWorktreeIsolation}) — both trivially unit-testable without git.
 *
 * Mirrors `agent_start.sandbox`'s `resolveSandboxProvider` injection shape,
 * except sandbox can default its resolver inside the runtime (the runtime
 * depends on `@agentproto/sandbox`); worktree cannot, so an unwired daemon
 * simply has no provisioner and a spawn that would need one fails loud rather
 * than silently spawning unisolated.
 */

import { loadConfig } from "./config.js"
import type { WorktreeIsolationMode } from "./config.js"

export type { WorktreeIsolationMode }

/** Env override for the isolation policy. Highest-priority source, ahead of
 *  the `worktrees.isolation` config field — see `loadWorktreeIsolation`. */
export const WORKTREE_ISOLATION_ENV = "AGENTPROTO_WORKTREES_ISOLATION"

/** The default when nothing is configured. Back-compat-preserving: a caller
 *  that passes no `worktree` field spawns exactly where it asked. */
export const DEFAULT_WORKTREE_ISOLATION: WorktreeIsolationMode = "on-request"

/**
 * The `agent_start.worktree` field. `true` isolates with an auto-minted slug;
 * an object additionally pins the slug and/or base ref; `false` (or omitted)
 * is "no explicit request" — the policy mode decides.
 */
export type WorktreeField = boolean | { slug?: string; base?: string }

/** The caller's explicit request, normalized — `undefined` when the field is
 *  absent or `false`, otherwise the (possibly empty) slug/base overrides. */
export interface WorktreeRequest {
  slug?: string
  base?: string
}

/** What the runtime hands the provisioner. `cwd` is where the session would
 *  otherwise spawn; the provisioner resolves the owning repo from it. */
export interface WorktreeProvisionRequest {
  cwd: string
  /** Explicit slug from the caller; omitted ⇒ the provisioner mints a
   *  collision-free one (see the host implementation). */
  slug?: string
  /** Base ref the worktree branch is cut from; omitted ⇒ the provisioner's
   *  default (`origin/main`). */
  base?: string
  /** Free-text label (the session's `label`) the provisioner may fold into a
   *  minted slug for human readability. Never load-bearing for correctness. */
  labelHint?: string
}

/** The provisioner's outcome. `isolated: false` is NOT a failure — it means
 *  there was nothing to isolate (`cwd` sits in no git repo), and the caller
 *  should spawn plain at the original cwd. A genuine failure throws. */
export type WorktreeProvisionOutcome =
  | { isolated: true; cwd: string; branch: string }
  | { isolated: false; reason: "not-a-git-repo" }

/**
 * Injected port: provision a git worktree for `req.cwd` and return the
 * worktree's own cwd for the spawn to land in. Wired at the composition root
 * by the CLI (over `@agentproto/worktree`); absent on a bare runtime.
 */
export type WorktreeProvisioner = (
  req: WorktreeProvisionRequest,
) => Promise<WorktreeProvisionOutcome>

/** The pure decision's three outcomes. */
export type WorktreeDecision =
  | { action: "spawn-in-place" }
  | { action: "provision"; request: WorktreeRequest }
  | { action: "reject"; message: string }

/**
 * Normalize the raw field into an explicit request, or `undefined` when the
 * caller made no request (`false` / omitted). An object with no overrides
 * still counts as a request (`{}`) — the caller opted in, just without pins.
 */
export function normalizeWorktreeField(
  field: WorktreeField | undefined,
): WorktreeRequest | undefined {
  if (field === undefined || field === false) return undefined
  if (field === true) return {}
  const request: WorktreeRequest = {}
  if (field.slug !== undefined) request.slug = field.slug
  if (field.base !== undefined) request.base = field.base
  return request
}

/**
 * The resolution matrix — mode × explicit-request × depth — with no side
 * effects. Every branch is exercised in `worktree-isolation.test.ts`.
 *
 * Depth-0 gate: a nested spawn (`depth > 0`, i.e. made through the scoped
 * orchestrator sub-gateway) NEVER provisions — it inherits its parent's
 * ground, per AIP-46 §Delegation. This bites before the mode is even
 * consulted, so `always` too provisions only at the root and an explicit
 * request from a nested spawn is a silent no-op (spawn-in-place), not a
 * reject: the child is meant to share the parent's tree.
 */
export function decideWorktreeIsolation(input: {
  mode: WorktreeIsolationMode
  field: WorktreeField | undefined
  depth: number
}): WorktreeDecision {
  const request = normalizeWorktreeField(input.field)

  // Nested spawns inherit the parent's ground — never a second worktree.
  if (input.depth > 0) return { action: "spawn-in-place" }

  switch (input.mode) {
    case "never":
      // A `never` policy is a loud contract: an explicit request is rejected
      // rather than silently ignored, so no caller believes it got an
      // isolated tree it didn't (and then writes in parallel unsafely).
      if (request !== undefined) {
        return {
          action: "reject",
          message:
            "agent_start: `worktree` was requested but this daemon's " +
            "`worktrees.isolation` policy is set to \"never\". Remove the " +
            "`worktree` field, or change the policy (config `worktrees.isolation` " +
            `/ env ${WORKTREE_ISOLATION_ENV}).`,
        }
      }
      return { action: "spawn-in-place" }
    case "on-request":
      return request !== undefined
        ? { action: "provision", request }
        : { action: "spawn-in-place" }
    case "always":
      // Forced daemon-side — no opt-out. An explicit `false` normalized to
      // `undefined` above still provisions here (with a minted slug).
      return { action: "provision", request: request ?? {} }
  }
}

/** Parse a raw string into a valid mode, or `undefined` when it isn't one. */
export function parseWorktreeIsolationMode(
  raw: string | undefined,
): WorktreeIsolationMode | undefined {
  return raw === "always" || raw === "on-request" || raw === "never" ? raw : undefined
}

/**
 * Resolve the effective isolation mode: env > config field > default. Mirrors
 * `resolveWorktreesRoot`'s precedence (there's no flag layer — this is read
 * daemon-side at spawn, not from an invocation). Never throws: an unreadable
 * config falls through to the default.
 */
export async function loadWorktreeIsolation(
  loadCfg: () => Promise<{ worktrees?: { isolation?: WorktreeIsolationMode } }> = loadConfig,
): Promise<WorktreeIsolationMode> {
  const fromEnv = parseWorktreeIsolationMode(process.env[WORKTREE_ISOLATION_ENV])
  if (fromEnv) return fromEnv
  try {
    const cfg = await loadCfg()
    const fromCfg = parseWorktreeIsolationMode(cfg.worktrees?.isolation)
    if (fromCfg) return fromCfg
  } catch {
    // fall through to default
  }
  return DEFAULT_WORKTREE_ISOLATION
}
