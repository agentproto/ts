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
