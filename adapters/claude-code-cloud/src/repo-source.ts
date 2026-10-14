/**
 * AIP-66 §3 (repo source): a managed cloud agent runs on a git remote and
 * ref — never on an uploaded working tree. The host MUST refuse the spawn
 * when `cwd` is not a git checkout with a remote, when the working tree is
 * dirty, or when HEAD is not reachable from the remote.
 *
 * Pure git-invocation logic with an injectable runner so tests can drive
 * every refusal from fixtures (no real repo required).
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/** Runs `git <args…>` in `cwd`; resolves with the exit code + streams. */
export type GitRunner = (
  args: string[],
  cwd: string,
) => Promise<{ code: number; stdout: string; stderr: string }>

export const defaultGitRunner: GitRunner = async (args, cwd) => {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    }
  }
}

/**
 * Refuse (throw) unless `cwd` is a clean git checkout whose HEAD is
 * contained in some `origin/*` ref. Each error names the failed condition —
 * the ACP server surfaces it as the `session/new` failure.
 */
export async function validateRepoSource(
  cwd: string,
  git: GitRunner = defaultGitRunner,
): Promise<void> {
  const inside = await git(["rev-parse", "--is-inside-work-tree"], cwd)
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    throw new Error(
      `claude code cloud: ${cwd} is not a git checkout — managed cloud ` +
        "agents run on a git remote and ref (AIP-66 §3)",
    )
  }

  const status = await git(["status", "--porcelain"], cwd)
  if (status.code !== 0) {
    throw new Error(
      `claude code cloud: could not read the working tree status in ${cwd} ` +
        `(${status.stderr.trim() || `git status exited ${status.code}`})`,
    )
  }
  if (status.stdout.trim().length > 0) {
    throw new Error(
      `claude code cloud: the working tree in ${cwd} is dirty — commit or ` +
        "stash first; the vendor refuses to upload uncommitted files " +
        "(AIP-66 §3)",
    )
  }

  const remote = await git(["remote", "get-url", "origin"], cwd)
  if (remote.code !== 0 || !remote.stdout.trim()) {
    throw new Error(
      `claude code cloud: ${cwd} has no origin remote — a managed cloud ` +
        "agent runs on the repo's remote, not a local path (AIP-66 §3)",
    )
  }

  const head = await git(["rev-parse", "HEAD"], cwd)
  if (head.code !== 0 || !head.stdout.trim()) {
    throw new Error(
      `claude code cloud: could not resolve HEAD in ${cwd} (${head.stderr.trim() || `git rev-parse HEAD exited ${head.code}`})`,
    )
  }

  // HEAD must be contained in some origin/* ref — i.e. pushed. An unpushed
  // commit (or a local-only branch) is refused; the vendor can only check
  // out what the remote actually has.
  const contains = await git(["branch", "-r", "--contains", "HEAD"], cwd)
  if (contains.code !== 0 || !contains.stdout.trim()) {
    throw new Error(
      `claude code cloud: HEAD in ${cwd} is not reachable from origin — ` +
        "push the commit before starting a cloud session (AIP-66 §3)",
    )
  }
}
