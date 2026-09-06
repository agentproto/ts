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
 * an object additionally pins the slug and/or base ref, and can opt into
 * async provisioning (`async: true` — see `WorktreeRequest.async`); `false`
 * (or omitted) is "no explicit request" — the policy mode decides.
 */
export type WorktreeField = boolean | { slug?: string; base?: string; async?: boolean }

/** The caller's explicit request, normalized — `undefined` when the field is
 *  absent or `false`, otherwise the (possibly empty) slug/base overrides. */
export interface WorktreeRequest {
  slug?: string
  base?: string
  /** Opt-in: return a real, registered session as soon as it's minted,
   *  provisioning the worktree in the BACKGROUND instead of blocking
   *  `agent_start`'s response on `git worktree add` + the repo's setup
   *  hooks (which can run minutes — see `session-spawn.ts`'s async-provision
   *  branch). Deliberately opt-in, not the default: existing callers that
   *  built on a synchronous ok/fail result (this package's own
   *  `worktree_provision_failed` test coverage among them) keep exactly
   *  today's behaviour unless they ask for the early return. Default
   *  false. */
  async?: boolean
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

/**
 * Injected port: best-effort attempt to reclaim ONE worktree by path, called
 * when its session reaches a terminal state (see
 * `SessionDescriptor.worktreeAutoProvisioned` and `createSessionsRegistry`'s
 * `runWorktreeAutoReclaim` option in `sessions.ts`). Deliberately scoped to
 * exactly the one path a session's own exit is allowed to touch — never a
 * repo-wide sweep. The implementation (wired by the CLI over
 * `@agentproto/worktree`'s `reclaimOneWorktree`) re-classifies fresh and only
 * ever removes the worktree when that comes back `reclaim` (merged-or-fresh,
 * clean, idle) — a dirty or held worktree is simply left alone. Must never
 * reject in a way the caller can't safely ignore; `sessions.ts` treats any
 * rejection as "couldn't reclaim this time, leave it for a manual or
 * scheduled `gc` sweep" and logs rather than lets it interrupt session
 * teardown. Absent on a bare runtime — auto-reclaim is simply skipped, and a
 * caller-explicit worktree request is never routed through this port at all
 * (see `WorktreeDecision.provision.implicit`).
 */
export type WorktreeAutoReclaimer = (worktreePath: string) => Promise<void>

/** The pure decision's three outcomes. `spawn-in-place` may carry a `warn`:
 *  a non-fatal notice the caller should surface (the child is about to run in
 *  a shared, dirty checkout it doesn't own). A `warn` never blocks the spawn —
 *  it's the loud-but-legitimate middle ground between silently spawning into a
 *  shared tree and hard-rejecting an in-place spawn that's normal at depth.
 *  `provision.implicit` is `true` exactly when the caller made no explicit
 *  `worktree` request and the `"always"` policy provisioned one anyway (the
 *  worktree the caller never asked to keep) — `false` whenever the request
 *  came from the caller itself (`on-request`'s only path here, or `"always"`
 *  with an explicit field). This is the signal `session-spawn.ts` threads
 *  onto the session descriptor so exit-time auto-reclaim (`sessions.ts`)
 *  only ever touches a worktree the daemon minted on its own — a worktree a
 *  caller explicitly asked to keep is never auto-removed. */
export type WorktreeDecision =
  | { action: "spawn-in-place"; warn?: string }
  | { action: "provision"; request: WorktreeRequest; implicit: boolean }
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
  if (field.async !== undefined) request.async = field.async
  return request
}

/**
 * The resolution matrix — mode × explicit-request × depth — with no side
 * effects. Every branch is exercised in `worktree-isolation.test.ts`.
 *
 * Depth-0 gate: a nested spawn (`depth > 0`, i.e. made through the scoped
 * orchestrator sub-gateway) NEVER provisions a worktree of its own — it
 * inherits its parent's ground, per AIP-46 §Delegation. This bites before
 * the mode is even consulted, so `always` too provisions only at the root.
 * But "never provisions" is NOT "silently ignore an explicit request": a
 * nested caller that passes an EXPLICIT `worktree` (`true` / `{slug}`) asked
 * for isolation and would silently get none — the spawn quietly runs in the
 * shared checkout, exactly the footgun that nearly clobbered a shared tree.
 * So an explicit request at depth > 0 is REJECTED loudly (same shape as the
 * `never`-policy reject below), pointing the caller at sandbox isolation —
 * child isolation is the sandbox, not a second worktree. Only the IMPLICIT/
 * absent case (`undefined` / `false`) stays an in-place spawn: the child is
 * meant to share the parent's tree and made no request to the contrary.
 *
 * That implicit case still has a footgun, though: the inherited cwd may be a
 * LIVE, DIRTY, shared checkout (the real repo, not a daemon-provisioned
 * worktree) — spawning in place there lets a nested child edit a tree someone
 * else is actively working in. We don't hard-reject it (implicit in-place is
 * legitimate and common), but we DON'T stay silent either: when the caller
 * hands us `sharedDirtyCwd` (an impure signal it computed — see
 * `session-spawn.ts`), the in-place spawn carries a `warn`. A caller that
 * genuinely intends it passes `allowSharedCwd` to acknowledge and silence the
 * warning. The signal is only consulted for the implicit nested case; every
 * other branch ignores it, keeping the root matrix unchanged.
 */
export function decideWorktreeIsolation(input: {
  mode: WorktreeIsolationMode
  field: WorktreeField | undefined
  depth: number
  /** Impure signal, computed by the caller (never inside this pure fn): the
   *  inherited cwd is a git work tree that is DIRTY and NOT a daemon-
   *  provisioned worktree — i.e. a shared checkout the child would edit in
   *  place. Only consulted for an implicit nested spawn. */
  sharedDirtyCwd?: boolean
  /** Caller's explicit acknowledgement that spawning into a shared dirty cwd
   *  is intended — silences the `sharedDirtyCwd` warning. */
  allowSharedCwd?: boolean
}): WorktreeDecision {
  const request = normalizeWorktreeField(input.field)

  // Nested spawns inherit the parent's ground — never a second worktree. An
  // explicit request can't be honoured here, so fail loud rather than silently
  // spawning unisolated (an absent request just spawns in place, unchanged).
  if (input.depth > 0) {
    if (request !== undefined) {
      return {
        action: "reject",
        message:
          "agent_start: `worktree` isolation was requested on a nested spawn " +
          `(depth ${input.depth}), but a spawn made through an orchestrator ` +
          "inherits its parent's working tree and cannot provision a worktree " +
          "of its own. Remove the `worktree` field; for an isolated child use " +
          "`sandbox` (the box already isolates) instead.",
      }
    }
    // Implicit in-place spawn. Legitimate, but loud when the inherited cwd is
    // a shared, dirty tree the child doesn't own — unless the caller opted in
    // via `allowSharedCwd`.
    if (input.sharedDirtyCwd && !input.allowSharedCwd) {
      return {
        action: "spawn-in-place",
        warn:
          "agent_start: this nested spawn is running in place in its parent's " +
          "working tree, which has UNCOMMITTED CHANGES and is not an isolated " +
          "worktree — the child can edit files someone else is actively " +
          "working in. This is allowed, but if it's unintended, spawn the " +
          "child with an explicit `cwd` inside its own checkout. Pass " +
          "`allowSharedCwd: true` to acknowledge and silence this warning.",
      }
    }
    return { action: "spawn-in-place" }
  }

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
      // Reaching "provision" here requires `request !== undefined` — the
      // caller always asked for this one, so `implicit` is always false.
      return request !== undefined
        ? { action: "provision", request, implicit: false }
        : { action: "spawn-in-place" }
    case "always":
      // Forced daemon-side — no opt-out. An explicit `false` normalized to
      // `undefined` above still provisions here (with a minted slug); that
      // case — and the true absent-field case — is exactly `implicit: true`.
      // An explicit request under `always` still contributes its pins, and
      // is `implicit: false` like any other caller-driven request.
      return { action: "provision", request: request ?? {}, implicit: request === undefined }
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
