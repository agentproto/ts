/**
 * Clone a Chrome profile directory into the agentproto automation
 * user-data-dir so chrome-devtools-mcp can drive it without locking
 * the user's daily Chrome. The clone preserves cookies, signed-in
 * sessions, and extensions — that's the whole reason to clone
 * instead of starting from an empty profile.
 *
 * Why clone instead of point Chrome at the real dir: Chrome holds an
 * exclusive lock on the user-data-dir (SingletonLock + per-profile
 * leveldb locks). Launching a second instance at the real path while
 * the daily Chrome is open fails. The clone lives at a separate
 * user-data-dir, so both can run side-by-side. Cost: the clone's
 * sessions drift from the daily Chrome's as cookies refresh; re-run
 * setup to re-sync.
 *
 * What we copy:
 *   - `Local State` (top-level): so Chrome knows the profile exists
 *     and which one is "last_used" inside the clone.
 *   - The chosen profile directory itself (everything under
 *     `Default/`, `Profile 1/`, …).
 *
 * What we skip (when copying the profile dir):
 *   - `Cache/`, `Code Cache/`, `GPUCache/` — large, regenerated on
 *     first launch.
 *   - `Service Worker/CacheStorage/` — large, optional.
 *   - `Singleton*` lock files — would prevent the new Chrome from
 *     starting if copied while the source Chrome is running.
 *
 * Skipping these gives roughly a 5–10× size reduction on a daily
 * Chrome (1.5 GB → 100–300 MB typical) without losing cookies,
 * extensions, or login state.
 */

import { promises as fs } from "node:fs"
import { dirname, join } from "node:path"
import { chromeUserDataDir } from "./chrome-profiles.js"

export interface CloneOptions {
  /** Source Chrome user-data-dir. Defaults to the OS-standard path. */
  sourceUserDataDir?: string
  /** Source profile directory name (`Default`, `Profile 1`, …). */
  sourceProfileDirectory: string
  /** Destination user-data-dir for the clone. Typically
   *  `~/.agentproto/chrome-profile`. */
  destUserDataDir: string
  /** Wipe the destination's profile dir first. Default true — a
   *  partial clone is worse than a clean re-clone. */
  cleanDestination?: boolean
  /** Callback fired for progress reporting; receives a relative path
   *  per file copied. */
  onProgress?: (relPath: string) => void
}

export interface CloneResult {
  filesCopied: number
  bytesCopied: number
  skippedDirs: string[]
}

/** Path segments inside a profile dir we deliberately omit. */
const SKIP_INSIDE_PROFILE = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "ShaderCache",
  "Service Worker",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GrShaderCache",
  "blob_storage",
  "File System",
  "Crashpad",
])

/** Top-level files we skip (locks/pidfiles, regenerated at launch). */
const SKIP_TOPLEVEL_PREFIX = ["Singleton", "lockfile", "RunningChromeVersion"]

export async function cloneChromeProfile(
  opts: CloneOptions
): Promise<CloneResult> {
  const src = opts.sourceUserDataDir ?? chromeUserDataDir()
  const dest = opts.destUserDataDir
  const profileDir = opts.sourceProfileDirectory
  const clean = opts.cleanDestination !== false

  await fs.mkdir(dest, { recursive: true })

  // Local State at the top level — strip transient fields so we don't
  // carry over the source's "last opened windows" state.
  const srcLocalState = join(src, "Local State")
  const destLocalState = join(dest, "Local State")
  try {
    const raw = await fs.readFile(srcLocalState, "utf8")
    await fs.writeFile(destLocalState, raw, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }

  const srcProfile = join(src, profileDir)
  const destProfile = join(dest, profileDir)

  if (clean) {
    await fs.rm(destProfile, { recursive: true, force: true })
  }
  await fs.mkdir(destProfile, { recursive: true })

  const result: CloneResult = {
    filesCopied: 0,
    bytesCopied: 0,
    skippedDirs: [],
  }
  await copyTree(srcProfile, destProfile, "", result, opts.onProgress)
  return result
}

async function copyTree(
  srcRoot: string,
  destRoot: string,
  rel: string,
  result: CloneResult,
  onProgress?: (relPath: string) => void
): Promise<void> {
  const srcDir = rel ? join(srcRoot, rel) : srcRoot
  const destDir = rel ? join(destRoot, rel) : destRoot
  const entries = await fs.readdir(srcDir, { withFileTypes: true })
  await fs.mkdir(destDir, { recursive: true })

  for (const entry of entries) {
    const childRel = rel ? join(rel, entry.name) : entry.name

    if (rel === "" && SKIP_TOPLEVEL_PREFIX.some(p => entry.name.startsWith(p))) {
      continue
    }
    if (entry.isDirectory()) {
      const isSkipped =
        SKIP_INSIDE_PROFILE.has(entry.name) ||
        // Some Chrome dirs nest a Cache/ several levels in — match
        // by trailing segment too.
        SKIP_INSIDE_PROFILE.has(entry.name.split("/").pop() ?? "")
      if (isSkipped) {
        result.skippedDirs.push(childRel)
        continue
      }
      await copyTree(srcRoot, destRoot, childRel, result, onProgress)
      continue
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue

    const srcFile = join(srcRoot, childRel)
    const destFile = join(destRoot, childRel)
    await fs.mkdir(dirname(destFile), { recursive: true })
    try {
      // copyFile with COPYFILE_FICLONE: cheap on APFS (CoW), falls
      // back to byte-copy on filesystems that don't support it.
      await fs.copyFile(srcFile, destFile, fs.constants.COPYFILE_FICLONE)
      const stat = await fs.stat(destFile)
      result.filesCopied += 1
      result.bytesCopied += stat.size
      onProgress?.(childRel)
    } catch (err) {
      // Cookies / Login Data can be locked while Chrome is open. Skip
      // them rather than aborting — the user can re-clone with
      // Chrome closed if they want a perfect snapshot.
      if (
        (err as NodeJS.ErrnoException).code === "EBUSY" ||
        (err as NodeJS.ErrnoException).code === "EACCES"
      ) {
        result.skippedDirs.push(childRel)
        continue
      }
      throw err
    }
  }
}
