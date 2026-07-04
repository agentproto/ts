/**
 * flat-dir installer — copies a single skill's directory into a target
 * skills directory, one subdirectory per skill (e.g. hermes's
 * `~/.hermes/skills/<name>/`). Generalized from the original
 * `installToHermes` — the destination base directory now travels through
 * `opts.dir` instead of being hardcoded, so any adapter declaring
 * `metadata.skills = { format: "flat-dir", dir: "..." }` can reuse it.
 */

import { cp, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { freshCopyDir, isSymlink, pathExists, promptOverwrite } from "./shared.js"
import type { SkillInstallHandler } from "./types.js"

export const installFlatDir: SkillInstallHandler = async (skill, opts, target) => {
  if (!opts.dir) {
    throw new Error(`installFlatDir: missing 'dir' for target '${target}'`)
  }
  const destDir = join(opts.dir, skill.name)

  // A symlinked skill is a deliberate dev link (edit-in-repo). Never clobber
  // it — `fs.cp` can't overwrite a symlink with a directory anyway
  // (ERR_FS_CP_DIR_TO_NON_DIR). Leave it and tell the user how to replace it.
  if (await isSymlink(destDir)) {
    return {
      target,
      status: "skipped",
      label: skill.name,
      detail: `symlinked at ${destDir} — left untouched (remove the link and re-run to replace)`,
    }
  }

  const exists = await pathExists(destDir)
  if (exists) {
    if (opts.dryRun) {
      return {
        target,
        status: "dry-run",
        label: skill.name,
        detail: `[dry-run] would overwrite ${destDir}`,
      }
    }
    const overwrite = opts.force || (await promptOverwrite(target, skill.name))
    if (!overwrite) {
      return {
        target,
        status: "skipped",
        label: skill.name,
        detail: `already exists at ${destDir}`,
      }
    }
    await freshCopyDir(skill.dir, destDir)
    return {
      target,
      status: "overwritten",
      label: skill.name,
      detail: destDir,
    }
  }

  if (opts.dryRun) {
    return {
      target,
      status: "dry-run",
      label: skill.name,
      detail: `[dry-run] would create ${destDir}`,
    }
  }

  await mkdir(dirname(destDir), { recursive: true })
  await cp(skill.dir, destDir, { recursive: true })
  return {
    target,
    status: "created",
    label: skill.name,
    detail: destDir,
  }
}
