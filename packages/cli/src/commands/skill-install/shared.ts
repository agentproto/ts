/**
 * Cross-cutting filesystem/UX helpers shared by every skill-install
 * handler (flat-dir / claude-plugin / desktop-bundle) and by the
 * `install-skill.ts` orchestrator.
 */

import { cp, lstat, mkdir, rm, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { createInterface } from "node:readline"
import { spawn } from "node:child_process"

/** Check if a path exists (as dir, file, or symlink). */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    // Also check for broken symlinks (stat follows, lstat doesn't)
    try {
      await lstat(p)
      return true
    } catch {
      return false
    }
  }
}

/** True when `p` exists and is itself a symlink (valid or broken). */
export async function isSymlink(p: string): Promise<boolean> {
  const st = await lstat(p).catch(() => null)
  return st?.isSymbolicLink() ?? false
}

/**
 * Replace `dest` with a fresh copy of the directory `src`. Removes any existing
 * file/dir at `dest` first, so a type mismatch (an old *file* where a directory
 * now goes) can't trip `fs.cp`'s ERR_FS_CP_DIR_TO_NON_DIR, and a stale prior
 * version is fully replaced rather than merged. Callers MUST handle a symlink
 * `dest` (a deliberate dev link) before calling this — `rm` would drop the link.
 */
export async function freshCopyDir(src: string, dest: string): Promise<void> {
  await rm(dest, { recursive: true, force: true })
  await mkdir(dirname(dest), { recursive: true })
  await cp(src, dest, { recursive: true })
}

/** Prompt the user on stdin: "Skill X already exists in Y. Overwrite? [y/N]" */
export async function promptOverwrite(
  label: string,
  name: string,
): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const answer = await new Promise<string>((resolvePromise) => {
    rl.question(
      `Skill "${name}" already exists in ${label}. Overwrite? [y/N] `,
      (a: string) => resolvePromise(a),
    )
  })

  rl.close()
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes"
}

export function spawnInherit(cmd: string, argv: string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, argv, { stdio: "inherit" })
    child.once("error", reject)
    child.once("exit", (code) => resolvePromise(code ?? 0))
  })
}
