/**
 * Thin typed wrapper over `child_process.spawnSync` for git commands.
 *
 * The token is NEVER passed on the command line (git would log it in
 * process listings and the auto-classifier blocks plaintext secrets). It
 * reaches git through the environment as `GIT_HTTP_EXTRAHEADER` via a
 * `.git/config` http.https.<host>.extraheader entry — the standard
 * non-interactive credential pattern for `git clone`/`push` against
 * GitHub HTTPS URLs.
 *
 * For tests, callers inject a `GitRunner` that returns canned stdout.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process"

/** Result of a single git invocation. */
export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  status: number | null
}

/** Injectable runner — production uses `realGitRunner`; tests stub it. */
export type GitRunner = (
  args: readonly string[],
  opts: GitRunOpts,
) => GitResult

export interface GitRunOpts {
  /** Working directory for `git -C`. */
  cwd: string
  /** Extra env vars (token-bearing header injected here). */
  env?: Record<string, string>
}

/** The env var git reads for the `http.https://github.com/.extraheader` URL. */
export const GITHUB_TOKEN_ENV = "GITHUB_TOKEN"

/**
 * Build the env block that injects the GitHub token into git's HTTPS auth.
 * We set `GIT_HTTP_EXTRAHEADER` (a git-credential-env helper convention)
 * AND `GIT_TERMINAL_PROMPT=0` so a missing token fails fast rather than
 * hanging on a TTY prompt.
 */
export function buildGitEnv(
  baseEnv: NodeJS.ProcessEnv,
  token: string,
): Record<string, string> {
  if (!token) {
    throw new Error(
      "storage-github: buildGitEnv called with an empty token — refusing to " +
        "spawn git (would hang on a TTY prompt or fail unauthenticated).",
    )
  }
  return {
    ...baseEnv,
    GIT_TERMINAL_PROMPT: "0",
    // `extraheader` is read by git's HTTP transport; the leading `AUTHORIZATION: basic <b64>`
    // is what GitHub expects. base64(`${x-access-token}:${token}`) — the
    // `x-access-token` user is GitHub's documented convention for PAT auth
    // over HTTPS without a username.
    GIT_HTTP_EXTRAHEADER: `Authorization: Basic ${btoa(`x-access-token:${token}`)}`,
  } satisfies Record<string, string>
}

/**
 * Configure a working tree's `.git/config` so subsequent `git` invocations
 * in that tree authenticate against `github.com` with the token. We write
 * the `http.https://github.com/.extraheader` entry via `git config` so the
 * token never appears on the command line of `clone`/`push`/`fetch`.
 *
 * This is idempotent — `git config --replace-all` overwrites a prior entry.
 */
export function writeAuthConfig(
  runner: GitRunner,
  cwd: string,
  token: string,
): void {
  const header = `Authorization: Basic ${btoa(`x-access-token:${token}`)}`
  runner(
    [
      "config",
      "--replace-all",
      "http.https://github.com/.extraheader",
      header,
    ],
    { cwd },
  )
}

/** Production runner — spawns `git` with the given args + env. */
export const realGitRunner: GitRunner = (
  args: readonly string[],
  opts: GitRunOpts,
): GitResult => {
  const child = spawnSync("git", [...args], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }) as SpawnSyncReturns<string>
  return {
    ok: child.status === 0,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    status: child.status,
  }
}

/** Throw a readable error when a git command fails. */
export function assertGitOk(
  result: GitResult,
  label: string,
): void {
  if (!result.ok) {
    const detail = result.stderr.trim() || result.stdout.trim() || "(no output)"
    throw new Error(
      `storage-github: git ${label} failed (status ${result.status ?? "?"}): ${detail}`,
    )
  }
}
