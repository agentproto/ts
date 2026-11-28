import { spawn } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"

/**
 * One shared pnpm content store per worktrees pool, plus cleanup of a
 * worktree's own virtual store.
 *
 * WHY: pnpm links packages out of its content store into each worktree's
 * `node_modules`. Hardlinks and APFS/reflink clones only work inside one
 * volume. When the store sits on a different volume than the worktrees (a
 * global `store-dir` on an external drive, worktrees on the system disk, or
 * the reverse), pnpm silently falls back to COPYING every package, so each
 * worktree costs gigabytes instead of almost nothing. The fix is to keep the
 * store on the same volume as the worktrees and to ask pnpm for
 * `clone-or-copy`, which clones where the filesystem can and only then copies.
 *
 * The default store is `<pool>/.pnpm-store`, where `<pool>` is the directory
 * that holds the worktree (`<worktrees.root>/<repo>` for `worktree new`).
 * Same volume as the worktree by construction, no machine-specific path.
 */

/** Explicit pin for the shared pnpm store directory used by setup hooks. */
export const WORKTREES_PNPM_STORE_DIR_ENV = "AGENTPROTO_WORKTREES_PNPM_STORE_DIR"

/** `0` / `false` / `off` disables the `pnpm store prune` run after a worktree removal. */
export const WORKTREES_PNPM_STORE_PRUNE_ENV = "AGENTPROTO_WORKTREES_PNPM_STORE_PRUNE"

/** Directory name of the shared store inside a worktrees pool. */
export const PNPM_STORE_DIRNAME = ".pnpm-store"

/**
 * Where the shared pnpm store for the pool holding `worktreePath` lives.
 * Precedence: `AGENTPROTO_WORKTREES_PNPM_STORE_DIR`, else `<pool>/.pnpm-store`.
 * A store inherited from the ambient pnpm env/config is deliberately NOT used:
 * the volume mismatch described above is exactly what such a store causes.
 */
export function resolveWorktreesPnpmStoreDir(worktreePath: string, env: NodeJS.ProcessEnv = process.env): string {
  const pinned = env[WORKTREES_PNPM_STORE_DIR_ENV]
  if (pinned) return resolve(pinned)
  return join(dirname(resolve(worktreePath)), PNPM_STORE_DIRNAME)
}

/**
 * The pnpm env a worktree setup hook runs with: the shared store and
 * `clone-or-copy` as import method (an already-exported
 * `npm_config_package_import_method` is respected). Applies to the hook's own
 * child process, not to commands run later in a plain shell.
 */
export function worktreesPnpmStoreEnv(worktreePath: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    npm_config_store_dir: resolveWorktreesPnpmStoreDir(worktreePath, env),
    npm_config_package_import_method: env.npm_config_package_import_method || "clone-or-copy",
  }
}

/** True unless pruning is switched off through {@link WORKTREES_PNPM_STORE_PRUNE_ENV}. */
export function pnpmStorePruneEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[WORKTREES_PNPM_STORE_PRUNE_ENV]?.trim().toLowerCase()
  return !(raw === "0" || raw === "false" || raw === "off")
}

function unquote(raw: string): string {
  const v = raw.trim()
  const m = /^(['"])(.*)\1/.exec(v)
  return (m ? m[2]! : v.replace(/\s+#.*$/, "")).trim()
}

function readIfFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

/**
 * The directory a worktree's pnpm config (`pnpm-workspace.yaml`
 * `virtualStoreDir`, or `.npmrc` `virtual-store-dir`) points its virtual store
 * at, when that directory is a per-worktree one OUTSIDE the worktree.
 *
 * Only a path that is outside the worktree (an inside one is deleted with it),
 * exists, is not an ancestor of the worktree, and has the worktree's own name
 * as its basename is returned. That last rule is what makes it safe to delete:
 * a directory shared by several worktrees is never named after just one.
 * The last occurrence of a key wins, as a per-worktree override appended to a
 * committed file does.
 */
export function findWorktreeVirtualStore(worktreePath: string): string | undefined {
  const wt = resolve(worktreePath)
  let found: string | undefined
  const yaml = readIfFile(join(wt, "pnpm-workspace.yaml"))
  if (yaml) {
    for (const line of yaml.split("\n")) {
      const m = /^virtualStoreDir\s*:\s*(.+)$/.exec(line)
      if (m) found = unquote(m[1]!)
    }
  }
  const npmrc = readIfFile(join(wt, ".npmrc"))
  if (npmrc) {
    for (const line of npmrc.split("\n")) {
      const m = /^\s*virtual-store-dir\s*=\s*(.+)$/.exec(line)
      if (m) found = unquote(m[1]!)
    }
  }
  if (!found) return undefined
  const target = resolve(wt, found)
  const rel = relative(wt, target)
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return undefined // inside the worktree
  const up = relative(target, wt)
  if (up === "" || (!up.startsWith("..") && !isAbsolute(up))) return undefined // ancestor of the worktree
  if (basename(target) !== basename(wt)) return undefined
  try {
    if (!statSync(target).isDirectory()) return undefined
  } catch {
    return undefined
  }
  return target
}

/** The shared store of `worktreePath`'s pool if it exists on disk. */
export function existingPnpmStoreDir(worktreePath: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = resolveWorktreesPnpmStoreDir(worktreePath, env)
  return existsSync(dir) ? dir : undefined
}

/**
 * Fire-and-forget `pnpm store prune` on `storeDir`, detached so the caller
 * never waits. A missing `pnpm` or a failed run is ignored: pruning only
 * reclaims space, it must never fail a worktree removal.
 */
export function spawnPnpmStorePrune(storeDir: string): void {
  try {
    const child = spawn("pnpm", ["store", "prune"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, npm_config_store_dir: storeDir },
    })
    child.on("error", () => {})
    child.unref()
  } catch {
    // best effort
  }
}
