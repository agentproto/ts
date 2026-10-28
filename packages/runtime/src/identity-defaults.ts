/**
 * Resolver for the `config.json` `defaults.identity` knobs (ts#2165 step 5).
 *
 * `defaults.identity.sessionTokens`: `"shadow"` (default) mints a per-session
 * token at spawn, puts it on the session's daemon self-mount and counts, on
 * the receiving side, how many calls are verified, claim-only, mismatching
 * or anonymous (`GET /identity`). Nothing is refused. `"off"`: no mint, no
 * header, no observation.
 *
 * Hot, read the same way as `messaging-defaults.ts`: the spawn paths read it
 * when a session is spawned (so a change applies to sessions spawned after
 * it), and the HTTP observer reads it per request.
 */

import { loadConfig } from "./config.js"
import type { SpawnDefaultsConfig } from "./spawn-defaults.js"

export type SessionTokenMode = "off" | "shadow"

export const DEFAULT_SESSION_TOKEN_MODE: SessionTokenMode = "shadow"

export interface ResolvedIdentityDefaults {
  sessionTokens: SessionTokenMode
}

/** `defaults.identity.sessionTokens` out of an already-loaded `defaults`
 *  block; anything but `"off"` / `"shadow"` falls back to the default. */
export function sessionTokenModeOf(defaults: SpawnDefaultsConfig | undefined): SessionTokenMode {
  const identity = (defaults as { identity?: { sessionTokens?: unknown } } | undefined)?.identity
  const mode = identity?.sessionTokens
  return mode === "off" || mode === "shadow" ? mode : DEFAULT_SESSION_TOKEN_MODE
}

export async function resolveIdentityDefaults(
  loadCfg: () => Promise<{ defaults?: SpawnDefaultsConfig }> = loadConfig,
): Promise<ResolvedIdentityDefaults> {
  try {
    return { sessionTokens: sessionTokenModeOf((await loadCfg()).defaults) }
  } catch {
    return { sessionTokens: DEFAULT_SESSION_TOKEN_MODE }
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
const SESSION_TOKEN_ADAPTERS: ReadonlySet<string> = new Set(["claude-code", "hermes"])

export function sessionTokenDeliverySafe(adapter: string | undefined, sandbox?: unknown): boolean {
  return sandbox === undefined && adapter !== undefined && SESSION_TOKEN_ADAPTERS.has(adapter)
}
