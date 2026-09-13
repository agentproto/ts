import { homedir } from "node:os"
import { join, resolve } from "node:path"

/**
 * Typed env surface for worktree lifecycle hooks, scripts, and services.
 *
 * Every `AGENTPROTO_*` variable the lifecycle feature injects is named here
 * once — bodies compose env via {@link hookEnv} / {@link serviceEnv} rather
 * than reading `process.env` (or writing literal `"AGENTPROTO_..."` keys)
 * ad hoc. Keeps the contract in one place and the derivations testable.
 */

/** The `AGENTPROTO_*` variables injected into every hook / script / service. */
export const ENV_VARS = {
  /** Absolute path to the original repo checkout the worktree was cut from. */
  sourceCheckoutPath: "AGENTPROTO_SOURCE_CHECKOUT_PATH",
  /** Absolute path to the worktree directory. */
  worktreePath: "AGENTPROTO_WORKTREE_PATH",
  /** The worktree's branch name. */
  branchName: "AGENTPROTO_BRANCH_NAME",
  /** A service's own allocated port. */
  port: "AGENTPROTO_PORT",
  /** A service's own reverse-proxy URL. */
  url: "AGENTPROTO_URL",
} as const

/** The shared context every worktree lifecycle command runs against. */
export interface WorktreeEnvContext {
  /** Absolute path to the original repo checkout. */
  sourceCheckoutPath: string
  /** Absolute path to the worktree directory. */
  worktreePath: string
  /** The worktree's branch name. */
  branchName: string
}

/**
 * Base env shared by hooks, scripts, and services — the worktree location and
 * the branch/checkout it derives from. Values are strings only (never
 * `undefined`), so the result merges cleanly onto `process.env`.
 */
export function hookEnv(ctx: WorktreeEnvContext): Record<string, string> {
  return {
    [ENV_VARS.sourceCheckoutPath]: ctx.sourceCheckoutPath,
    [ENV_VARS.worktreePath]: ctx.worktreePath,
    [ENV_VARS.branchName]: ctx.branchName,
  }
}

/** A sibling service, as seen by a peer's env. */
export interface PeerService {
  /** The declared script name (e.g. `"web"`). */
  name: string
  /** The port the service listens on. */
  port: number
  /** The service's reverse-proxy URL. */
  url: string
}

/**
 * Upper-case a service name and replace every non-alphanumeric run with a
 * single `_`, for use inside an env var key (`web-api` → `WEB_API`).
 */
export function serviceEnvToken(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

/** `AGENTPROTO_SERVICE_<TOKEN>_PORT` / `..._URL` for a named peer. */
export function peerEnvKey(name: string, suffix: "PORT" | "URL"): string {
  return `AGENTPROTO_SERVICE_${serviceEnvToken(name)}_${suffix}`
}

/**
 * Peer-discovery env for a set of sibling services: each contributes
 * `AGENTPROTO_SERVICE_<NAME>_PORT` and `AGENTPROTO_SERVICE_<NAME>_URL`.
 */
export function peerEnv(peers: readonly PeerService[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const peer of peers) {
    out[peerEnvKey(peer.name, "PORT")] = String(peer.port)
    out[peerEnvKey(peer.name, "URL")] = peer.url
  }
  return out
}

/**
 * Full env for a running service: the shared {@link hookEnv}, the service's
 * own `AGENTPROTO_PORT` / `AGENTPROTO_URL`, and {@link peerEnv} for every
 * sibling.
 */
export function serviceEnv(args: {
  ctx: WorktreeEnvContext
  self: PeerService
  peers: readonly PeerService[]
}): Record<string, string> {
  return {
    ...hookEnv(args.ctx),
    [ENV_VARS.port]: String(args.self.port),
    [ENV_VARS.url]: args.self.url,
    ...peerEnv(args.peers),
  }
}

/** Explicit override for {@link resolveWorktreesTurboCacheDir} — a daemon-
 *  level pin, same naming shape as `AGENTPROTO_WORKTREES_ROOT`/
 *  `AGENTPROTO_WORKTREES_ISOLATION` in `@agentproto/runtime`. */
export const WORKTREES_TURBO_CACHE_DIR_ENV = "AGENTPROTO_WORKTREES_TURBO_CACHE_DIR"

/**
 * Resolve the turbo build-cache directory `runSetup` points every
 * provisioned worktree's setup hooks at (`TURBO_CACHE_DIR` — see turbo's own
 * `--cache-dir` flag, which this env var sets). Measured on a real machine
 * (WP-F): a repo's main checkout carries a turbo cache in the hundreds of MB;
 * a freshly provisioned worktree, with none, pays a full cold `pnpm build`
 * (~103 tasks) instead of a cache restore. `agentproto.json`'s own
 * `worktree.setup` never set this, so every worktree paid that cost
 * independently — this closes it by pointing every worktree at ONE shared
 * directory instead.
 *
 * Deliberately NOT inside any worktree (would die with `worktree rm`) and
 * NOT inside the monorepo checkout being built (would otherwise sit inside
 * pnpm's/turbo's own workspace-relative globs, risking either tool treating
 * its own cache as workspace content). Precedence, matching the rest of this
 * codebase's `worktrees.*` knobs:
 *   1. `AGENTPROTO_WORKTREES_TURBO_CACHE_DIR` — explicit override.
 *   2. a bare `TURBO_CACHE_DIR` already in this process's env — an operator
 *      who already exports it (AGENTS.md's own advice, for a *manually*
 *      driven worktree) is respected rather than silently redirected.
 *   3. `~/.agentproto/turbo-cache` — a real, single default, mirroring
 *      `worktrees.root`'s own reasoning: zero-config still converges every
 *      worktree's build cache to one shared place rather than leaving it
 *      unset (today's behaviour — each worktree builds cold).
 */
export function resolveWorktreesTurboCacheDir(): string {
  const pinned = process.env[WORKTREES_TURBO_CACHE_DIR_ENV]
  if (pinned) return resolve(pinned)
  const ambient = process.env.TURBO_CACHE_DIR
  if (ambient) return ambient
  return join(homedir(), ".agentproto", "turbo-cache")
}
