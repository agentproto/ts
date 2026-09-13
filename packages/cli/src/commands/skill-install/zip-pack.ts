/**
 * Single shared `zip` implementation for a skill pack directory. Used by
 * `claude-plugin.ts` (consumer-side install, `agentproto install skill/...`)
 * and by `agentproto pack build` (producer-side, release-time build of the
 * `packages/skill-pack-<name>` packages) — one zip technique, not one per
 * caller.
 */

import { basename, dirname, resolve } from "node:path"
import { spawnInherit } from "./shared.js"

export interface ZipPackResult {
  zipped: boolean
  zipPath: string
}

/**
 * Best-effort zip of `dirToZip` into `<dirToZip>.zip` (or `zipPath` when
 * given). The directory is the canonical artifact; the archive is a
 * convenience — `zip` may be absent on minimal/Windows environments, so a
 * failure to zip is reported via `zipped: false` rather than thrown.
 *
 * Runs `zip` with cwd set to `dirToZip`'s parent and zips its bare basename,
 * so archive entries read as `<name>/...` — not the full absolute path a
 * naive `zip -r <zipPath> <dirToZip>` would bake in when `dirToZip` is
 * absolute (as every caller here passes it). Unzipping must not recreate
 * the machine's own directory tree.
 */
export async function zipPackDir(
  dirToZip: string,
  zipPath: string = `${dirToZip}.zip`,
): Promise<ZipPackResult> {
  const absoluteZipPath = resolve(zipPath)
  try {
    const code = await spawnInherit(
      "zip",
      ["-r", "-q", absoluteZipPath, basename(dirToZip)],
      { cwd: dirname(dirToZip) },
    )
    return { zipped: code === 0, zipPath: absoluteZipPath }
  } catch {
    return { zipped: false, zipPath: absoluteZipPath }
  }
}
