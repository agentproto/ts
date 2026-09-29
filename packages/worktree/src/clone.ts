import { mkdir, lstat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { execArgv } from "./exec.js"
import { ProvisionCancelledError } from "./provision-scheduler.js"
import { expandCloneGlob } from "./glob.js"

/**
 * Copy one matched entry (file or directory) from `src` to `dest` using a
 * copy-on-write clone where the filesystem supports it:
 *   - macOS: `cp -Rc` — clonefile(2). Per `cp(1)`, if the source and target
 *     are on different filesystems, or the target filesystem doesn't
 *     support cloning, `cp` itself falls back to a regular copy — so a
 *     non-zero exit here is a genuine failure, not "no CoW support".
 *   - Linux: `cp -r --reflink=auto` — GNU coreutils' own auto-fallback,
 *     same guarantee.
 *   - Any other platform: no CoW attempt, straight to the plain-copy
 *     fallback below.
 * Never a symlink: the clone must be an independent, writable tree a
 * package manager can repair/mutate without touching the source checkout.
 */
async function cloneEntry(src: string, dest: string, signal?: AbortSignal): Promise<void> {
  const execOpts = signal ? { signal } : {}
  await mkdir(dirname(dest), { recursive: true })
  const platform = process.platform
  const cloneArgs =
    platform === "darwin"
      ? ["-Rc", src, dest]
      : platform === "linux"
        ? ["-r", "--reflink=auto", src, dest]
        : null
  if (cloneArgs) {
    const result = await execArgv("cp", cloneArgs, dirname(dest), execOpts)
    if (result.exitCode === 0) return
    // A killed `cp` exits non-zero too; never fall through to a second copy.
    if (signal?.aborted) throw new ProvisionCancelledError()
  }
  const fallback = await execArgv("cp", ["-R", src, dest], dirname(dest), execOpts)
  if (signal?.aborted) throw new ProvisionCancelledError()
  if (fallback.exitCode !== 0) {
    throw new Error(
      `clone of '${src}' into '${dest}' failed: ${fallback.stderr || fallback.stdout}`,
    )
  }
}

/**
 * Clone every entry matched by `patterns` (see {@link expandCloneGlob}) from
 * `repoRoot` into `cwd`, meant to run BEFORE `depsCmd` so a gitignored,
 * expensive-to-recreate tree (e.g. `node_modules`) is already present when
 * the package manager runs — turning `depsCmd` into a quick verify/repair
 * instead of a full reinstall. Skips an entry whose destination already
 * exists — same never-clobber rule `linkPaths`/`writeFiles` follow in
 * `provision-worktree.body.ts`. `signal` cancels mid-copy (the `cp` process
 * group is killed) with {@link ProvisionCancelledError}.
 */
export async function cloneEntries(
  repoRoot: string,
  cwd: string,
  patterns: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  for (const pattern of patterns) {
    const matches = await expandCloneGlob(repoRoot, pattern)
    for (const rel of matches) {
      if (signal?.aborted) throw new ProvisionCancelledError()
      const dest = join(cwd, rel)
      const existing = await lstat(dest).catch(() => null)
      if (existing) continue
      await cloneEntry(join(repoRoot, rel), dest, signal)
    }
  }
}
