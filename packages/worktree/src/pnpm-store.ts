import { spawn } from "node:child_process"
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs"
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

/** `1` / `true` / `on` enables the `pnpm store prune` run after a worktree removal (off by default). */
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

/**
 * True when pruning was switched on through {@link WORKTREES_PNPM_STORE_PRUNE_ENV}.
 * Opt-in: with clone or copy imports pnpm cannot tell which packages are still
 * used, so a prune can drop most of the store and make every install fetch
 * again; and a prune can race with an install running in another worktree.
 */
export function pnpmStorePruneEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[WORKTREES_PNPM_STORE_PRUNE_ENV]?.trim().toLowerCase()
  return raw === "1" || raw === "true" || raw === "on"
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
 * Those config files are versioned, so their content is untrusted input to a
 * deletion. A path is returned only when ALL hold: it is outside the worktree
 * and not an ancestor of it (compared by realpath), it is a real directory
 * (not a symlink), its basename is the worktree's own name, it looks like a
 * pnpm virtual store (holds `lock.yaml` or `node_modules`), and it holds no
 * `.git` (so another worktree or a checkout is never taken). `pnpm-workspace.yaml`
 * wins over `.npmrc`, as in pnpm; the last occurrence of a key wins.
 */
export function findWorktreeVirtualStore(worktreePath: string): string | undefined {
  let wt: string
  try {
    wt = realpathSync(resolve(worktreePath))
  } catch {
    return undefined
  }
  let found: string | undefined
  const npmrc = readIfFile(join(wt, ".npmrc"))
  if (npmrc) {
    for (const line of npmrc.split(/\r?\n/)) {
      const m = /^\s*virtual-store-dir\s*=\s*(.+)$/.exec(line)
      if (m) found = unquote(m[1]!)
    }
  }
  const yaml = readIfFile(join(wt, "pnpm-workspace.yaml"))
  if (yaml) {
    for (const line of yaml.split(/\r?\n/)) {
      const m = /^virtualStoreDir\s*:\s*(.+)$/.exec(line)
      if (m) found = unquote(m[1]!)
    }
  }
  if (!found) return undefined
  const wanted = resolve(wt, found)
  try {
    if (lstatSync(wanted).isSymbolicLink() || !lstatSync(wanted).isDirectory()) return undefined
    const target = realpathSync(wanted)
    const rel = relative(wt, target)
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return undefined // inside the worktree
    const up = relative(target, wt)
    if (up === "" || (!up.startsWith("..") && !isAbsolute(up))) return undefined // ancestor of the worktree
    if (basename(target) !== basename(wt)) return undefined
    const entries = readdirSync(target)
    if (entries.includes(".git")) return undefined
    if (!entries.includes("lock.yaml") && !entries.includes("node_modules")) return undefined
    return target
  } catch {
    return undefined
  }
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
