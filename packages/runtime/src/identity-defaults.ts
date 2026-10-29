/**
 * Resolver for the `config.json` `defaults.identity` knobs (ts#2165 step 5).
 *
 * `defaults.identity.sessionTokens`: `"shadow"` (default) mints a per-session
 * token at spawn, puts it on the session's daemon self-mount and counts, on
 * the receiving side, how many calls are verified, claim-only, mismatching
 * or anonymous (`GET /identity`). Nothing is refused. `"enforce"` mints and
 * delivers exactly like `"shadow"` and also refuses, per request, an invalid
 * token, a mismatching claim and a claim without token naming a session the
 * token was delivered to (AIP-46 §Session principals rules 3, 4 and 8).
 * `"off"`: no mint, no header, no observation, nothing refused.
 *
 * Hot, read the same way as `messaging-defaults.ts`: the spawn paths read it
 * when a session is spawned (so a change applies to sessions spawned after
 * it), and the HTTP observer reads it per request.
 */

import { loadConfig } from "./config.js"
import type { SpawnDefaultsConfig } from "./spawn-defaults.js"

export type SessionTokenMode = "off" | "shadow" | "enforce"

export const DEFAULT_SESSION_TOKEN_MODE: SessionTokenMode = "shadow"

export interface ResolvedIdentityDefaults {
  sessionTokens: SessionTokenMode
}

/** `defaults.identity.sessionTokens` out of an already-loaded `defaults`
 *  block; anything but `"off"` / `"shadow"` / `"enforce"` falls back to the
 *  default. */
export function sessionTokenModeOf(defaults: SpawnDefaultsConfig | undefined): SessionTokenMode {
  const mode = defaults?.identity?.sessionTokens
  return mode === "off" || mode === "shadow" || mode === "enforce" ? mode : DEFAULT_SESSION_TOKEN_MODE
}

let warnedResolveFailure = false

export async function resolveIdentityDefaults(
  loadCfg: () => Promise<{ defaults?: SpawnDefaultsConfig }> = loadConfig,
): Promise<ResolvedIdentityDefaults> {
  try {
    return { sessionTokens: sessionTokenModeOf((await loadCfg()).defaults) }
  } catch (err) {
    // The fallback is fail-open: in enforce mode a broken config read would
    // silently stop refusing. Say so once so an operator can tell.
    if (!warnedResolveFailure) {
      warnedResolveFailure = true
      console.warn(
        `[identity] could not resolve defaults.identity.sessionTokens; falling back to ` +
          `"${DEFAULT_SESSION_TOKEN_MODE}" (enforce is not active): ` +
          (err instanceof Error ? err.message : String(err)),
      )
    }
    return { sessionTokens: DEFAULT_SESSION_TOKEN_MODE }
  }
}

/** How long the per-request observer reuses a resolved mode. */
export const IDENTITY_MODE_CACHE_MS = 5_000

/**
 * The mode reader for the per-request observer. `observeCallerIdentity`
 * runs on every `/mcp` call, and `resolveIdentityDefaults` loads and
 * validates `config.json` each time, so the answer is reused for
 * {@link IDENTITY_MODE_CACHE_MS}: a `config_set` of the knob applies within
 * that window instead of on the very next call. Concurrent callers share one
 * in-flight load.
 */
export function createIdentityModeReader(
  load: () => Promise<ResolvedIdentityDefaults> = resolveIdentityDefaults,
  ttlMs: number = IDENTITY_MODE_CACHE_MS,
  now: () => number = Date.now,
): () => Promise<SessionTokenMode> {
  let cached: { mode: SessionTokenMode; at: number } | undefined
  let inflight: Promise<SessionTokenMode> | undefined
  return () => {
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.mode)
    inflight ??= load()
      .then(r => {
        cached = { mode: r.sessionTokens, at: now() }
        return r.sessionTokens
      })
      .finally(() => {
        inflight = undefined
      })
    return inflight
  }
}

/**
 * Adapters whose mounts reach the agent in memory (ACP `session/new`), so a
 * session token on a mount header is never written to a file the session's
 * workspace could commit. A print-arm adapter such as mastracode writes its
 * mounts, headers included, into `<cwd>/.mastracode/mcp.json`; those get no
 * token in this step. Sandbox spawns get none either (the mounts are
 * forwarded to the box daemon, which persists them on its own descriptor).
 */
export const SESSION_TOKEN_ADAPTERS: ReadonlySet<string> = new Set(["claude-code", "hermes"])

/** Whether `mode` mints and delivers a session token (`"shadow"` and
 *  `"enforce"` alike; only `"off"` does not). */
export function sessionTokensMinted(mode: SessionTokenMode): boolean {
  return mode !== "off"
}

export function sessionTokenDeliverySafe(adapter: string | undefined, sandbox?: unknown): boolean {
  return sandbox === undefined && adapter !== undefined && SESSION_TOKEN_ADAPTERS.has(adapter)
}
