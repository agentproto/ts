import { basename } from "node:path"
import { execArgv } from "../exec.js"

/**
 * Derive the hostname-facing repo label from a repo root path — its directory
 * basename (the proxy slugs it further).
 */
export function repoLabel(repoRoot: string): string {
  return basename(repoRoot.replace(/[/\\]+$/, ""))
}

/**
 * Best-effort detection of a repo's default branch, for deciding whether the
 * branch label is dropped from a service hostname. Prefers the symbolic
 * `origin/HEAD` ref, falls back to `main` / `master` presence, then `main`.
 */
export async function detectDefaultBranch(repoRoot: string): Promise<string> {
  const head = await execArgv(
    "git",
    ["-C", repoRoot, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    repoRoot,
  )
  if (head.exitCode === 0) {
    const ref = head.stdout.trim() // e.g. "origin/main"
    const slash = ref.lastIndexOf("/")
    if (slash !== -1) return ref.slice(slash + 1)
    if (ref) return ref
  }
  for (const candidate of ["main", "master"]) {
    const exists = await execArgv(
      "git",
      ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`],
      repoRoot,
    )
    if (exists.exitCode === 0) return candidate
  }
  return "main"
}
