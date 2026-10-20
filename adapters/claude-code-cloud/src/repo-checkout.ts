/**
 * Declared repo source (AIP-66 §3): when the host's workspace declares a git
 * remote (`workspaces.json` → `remote`), the relay does not need a local
 * clone at the session cwd. The host hands the remote through env and the
 * relay materializes its OWN clean checkout of `origin/<branch>` in a dir
 * inside the session's isolated config dir — the same "declare the repo, the
 * box clones it" shape a sandbox spawn uses. `claude --cloud` then runs from
 * that checkout, so the vendor sees a clean tree whose HEAD is on the remote.
 *
 * The git token (when the workspace has a `credentialRef`) rides
 * {@link CLOUD_GIT_TOKEN_ENV} and is read ONLY by a per-command
 * `credential.helper` — it never appears in argv, in the clone URL, or in the
 * checkout's `.git/config`.
 */

import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { defaultGitRunner, type GitRunner } from "./repo-source.js"

/** https remote URL of the declared repo (no userinfo — the host validated it). */
export const CLOUD_REPO_URL_ENV = "AGENTPROTO_CLOUD_REPO_URL"
/** Branch to check out; absent ⇒ {@link DEFAULT_CLOUD_REPO_BRANCH}. */
export const CLOUD_REPO_BRANCH_ENV = "AGENTPROTO_CLOUD_REPO_BRANCH"
/** Absolute dir the relay clones into (inside the isolated config dir). */
export const CLOUD_REPO_DIR_ENV = "AGENTPROTO_CLOUD_REPO_DIR"
/** Git token for a private remote — same name the sandbox clone uses. */
export const CLOUD_GIT_TOKEN_ENV = "AGENTPROTO_GIT_TOKEN"

export const DEFAULT_CLOUD_REPO_BRANCH = "main"

export interface CloudRepoSource {
  url: string
  branch: string
  dir: string
}

/** Read the declared repo source from env. `null` when none is declared (the
 *  relay then validates the session cwd as before); throws on a half-set
 *  source so a misconfigured host fails closed instead of running on the cwd. */
export function cloudRepoSourceFromEnv(
  env: Record<string, string | undefined> = process.env,
): CloudRepoSource | null {
  const url = env[CLOUD_REPO_URL_ENV]?.trim()
  const dir = env[CLOUD_REPO_DIR_ENV]?.trim()
  if (!url && !dir) return null
  if (!url || !dir) {
    throw new Error(
      `claude code cloud: ${CLOUD_REPO_URL_ENV} and ${CLOUD_REPO_DIR_ENV} ` +
        "must be set together",
    )
  }
  const branch = env[CLOUD_REPO_BRANCH_ENV]?.trim() || DEFAULT_CLOUD_REPO_BRANCH
  return { url, branch, dir }
}

/** `-c` pairs prepended to every network git command: reset any inherited
 *  helper, then (with a token) answer from the env var by name only. */
function credentialArgs(hasToken: boolean): string[] {
  if (!hasToken) return ["-c", "credential.helper="]
  return [
    "-c",
    "credential.helper=",
    "-c",
    `credential.helper=!f() { echo username=x-access-token; echo "password=$${CLOUD_GIT_TOKEN_ENV}"; }; f`,
  ]
}

async function run(git: GitRunner, args: string[], cwd: string, what: string): Promise<string> {
  const res = await git(args, cwd)
  if (res.code !== 0) {
    throw new Error(
      `claude code cloud: could not ${what} (${res.stderr.trim() || `git exited ${res.code}`})`,
    )
  }
  return res.stdout
}

/**
 * Make `source.dir` a clean checkout of `origin/<branch>` and return it.
 * First call clones (shallow); a later call (resume against the same config
 * dir) fetches and hard-resets, so the tree is always clean and pushed. A dir
 * already holding a DIFFERENT remote is refused rather than reused.
 */
export async function materializeRepoCheckout(
  source: CloudRepoSource,
  opts: { git?: GitRunner; hasToken?: boolean } = {},
): Promise<string> {
  const git = opts.git ?? defaultGitRunner
  const hasToken = opts.hasToken ?? Boolean(process.env[CLOUD_GIT_TOKEN_ENV])
  const creds = credentialArgs(hasToken)
  const { url, branch, dir } = source

  if (!existsSync(join(dir, ".git"))) {
    await mkdir(dirname(dir), { recursive: true })
    await run(
      git,
      [...creds, "clone", "--depth", "1", "--branch", branch, "--", url, dir],
      dirname(dir),
      `clone ${url} (${branch})`,
    )
    return dir
  }

  const origin = (await run(git, ["remote", "get-url", "origin"], dir, `read origin in ${dir}`)).trim()
  if (origin !== url) {
    throw new Error(
      `claude code cloud: ${dir} is a checkout of ${origin}, not the declared ` +
        `remote ${url} — refusing to reuse it`,
    )
  }
  await run(
    git,
    [...creds, "fetch", "--depth", "1", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    dir,
    `fetch ${branch} from ${url}`,
  )
  await run(git, ["checkout", "-f", "-B", branch, `origin/${branch}`], dir, `check out origin/${branch}`)
  await run(git, ["clean", "-ffdx"], dir, `clean ${dir}`)
  return dir
}
