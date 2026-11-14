/**
 * Shared tool caches under a redirected base dir.
 *
 * When the driver points a base-dir env var at a per-session dir (opencode's
 * `credentialDataHome` sets `XDG_DATA_HOME=<configDir>/auth-data`), every
 * process the agent runs inherits it, not only the CLI itself. Tools that
 * derive a content-addressed cache from that var then build a fresh one per
 * session: pnpm >= 11 puts its store at `$XDG_DATA_HOME/pnpm/store`, so every
 * session that ran `pnpm install` held its own 5-6 GB store (1764 session
 * dirs, 124 GB on one host, 2026-10-27).
 *
 * Pinning each tool through its own env var does not hold up: pnpm 11 reads
 * `pnpm_config_store_dir` and ignores `npm_config_store_dir`, pnpm 10 does the
 * opposite, and an explicit store dir also disables pnpm's rule of putting
 * the store on the project's volume when the default one is elsewhere. So the
 * cache path inside the isolated home is LINKED to the location the tool
 * would have used without the redirect, resolved from the ambient env. The
 * tool still resolves its own default and applies its own rules, it only
 * lands in the operator's store. Nothing credential-bearing is ever linked
 * (opencode's `opencode.db` stays isolated), so the redirect keeps doing its
 * job.
 *
 * Confined spawns are left alone: the real cache is outside the sandbox
 * grants, and granting it would let a confined agent write into a store every
 * later unconfined install reads. Their caches stay per session and are
 * listed in the session cache manifest, so session GC reclaims them.
 */

import { lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

export interface SharedToolCache {
  /** Stable id, for logs and tests. */
  id: string
  /** Path the tool uses under the redirected base dir (`pnpm/store`). */
  path: string
  /** Where the tool puts it without the redirect, from the ambient env.
   *  `undefined` means unknown on this platform: nothing is linked. */
  real(ctx: { env: Record<string, string | undefined>; home: string; platform: NodeJS.Platform }): string | undefined
}

function ambientDir(env: Record<string, string | undefined>, name: string): string | undefined {
  const v = env[name]
  return v && isAbsolute(v) ? v : undefined
}

/**
 * The caches known to derive from each base-dir var, keyed by that var.
 * Each entry was checked against the tool itself (`pnpm store path`,
 * `uv python dir`) with and without the var set.
 */
export const SHARED_TOOL_CACHES: Readonly<Record<string, readonly SharedToolCache[]>> = {
  XDG_DATA_HOME: [
    {
      // pnpm's default store: $XDG_DATA_HOME/pnpm/store when set, else the
      // platform data dir (`~/Library/pnpm/store` on macOS).
      id: "pnpm-store",
      path: "pnpm/store",
      real({ env, home, platform }) {
        const xdg = ambientDir(env, "XDG_DATA_HOME")
        if (xdg) return join(xdg, "pnpm", "store")
        if (platform === "darwin") return join(home, "Library", "pnpm", "store")
        if (platform === "win32") {
          return join(ambientDir(env, "LOCALAPPDATA") ?? join(home, "AppData", "Local"), "pnpm", "store")
        }
        return join(home, ".local", "share", "pnpm", "store")
      },
    },
    {
      // uv's managed Python installs: $XDG_DATA_HOME/uv/python, else
      // ~/.local/share/uv/python (macOS included).
      id: "uv-python",
      path: "uv/python",
      real({ env, home, platform }) {
        const xdg = ambientDir(env, "XDG_DATA_HOME")
        if (xdg) return join(xdg, "uv", "python")
        if (platform === "win32") return undefined
        return join(home, ".local", "share", "uv", "python")
      },
    },
  ],
}

/** The cache paths (relative to the redirected dir) known for `envVar`. */
export function sharedToolCachePaths(envVar: string): string[] {
  return (SHARED_TOOL_CACHES[envVar] ?? []).map(c => c.path)
}

export interface LinkSharedToolCachesResult {
  /** Cache paths now linked to the operator's location. */
  linked: string[]
  /** Cache paths left as they are: a real dir from an earlier spawn, or no
   *  known location on this platform. */
  skipped: string[]
}

/**
 * Link every known cache of `envVar` under `dir` (the redirected base dir)
 * to the operator's location. Idempotent across respawns of a lineage: a
 * correct link is kept, a stale one replaced. A real directory already in
 * place (a store built before this existed) is never deleted here, since the
 * session may still have `node_modules` hard-linked into it; GC reclaims it
 * once the session is dead.
 */
export function linkSharedToolCaches(opts: {
  dir: string
  envVar: string
  /** The env as it was BEFORE the redirect (the daemon's own). */
  ambientEnv: Record<string, string | undefined>
  home?: string
  platform?: NodeJS.Platform
}): LinkSharedToolCachesResult {
  const home = opts.home ?? homedir()
  const platform = opts.platform ?? process.platform
  const out: LinkSharedToolCachesResult = { linked: [], skipped: [] }
  for (const cache of SHARED_TOOL_CACHES[opts.envVar] ?? []) {
    const real = cache.real({ env: opts.ambientEnv, home, platform })
    const link = join(opts.dir, cache.path)
    // No known location, or the ambient var already points at this very dir.
    if (!real || resolve(real) === resolve(link)) {
      out.skipped.push(cache.path)
      continue
    }
    let existing: ReturnType<typeof lstatSync> | undefined
    try {
      existing = lstatSync(link)
    } catch {
      // absent
    }
    if (existing && !existing.isSymbolicLink()) {
      out.skipped.push(cache.path)
      continue
    }
    try {
      if (existing) {
        if (readlinkSync(link) === real) {
          out.linked.push(cache.path)
          continue
        }
        unlinkSync(link)
      }
      // The tool would create its default dir itself; create it so the link
      // never dangles.
      mkdirSync(real, { recursive: true })
      mkdirSync(dirname(link), { recursive: true })
      symlinkSync(real, link, platform === "win32" ? "junction" : "dir")
      out.linked.push(cache.path)
    } catch {
      // Best-effort: an unwritable operator location only means this cache
      // stays per session (and GC reclaims it). Never fails the spawn.
      out.skipped.push(cache.path)
    }
  }
  return out
}
