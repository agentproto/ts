/**
 * `ForgeClient` — the only network-facing surface the reconciliation rule
 * (`status.ts`) depends on. Kept as an interface (not a concrete `gh` call)
 * so:
 *   1. `status.ts` stays testable with a fake — the fixture-repo tests never
 *      shell out to a real forge or touch the network.
 *   2. The shape is forge-portable by construction (PLAN.md §7.1): GitLab has
 *      the same two facts — "PRs/MRs whose head is this branch" and "PRs/MRs
 *      that contain this commit" — under different verbs
 *      (`refs/merge-requests/<n>/head`, `GET /merge_requests?…`). Only
 *      GitHub ships today; a `GitlabForgeClient` is a second implementation
 *      of this same interface, not a redesign.
 *
 * Two implementations ship: `GhCliForgeClient` (shells out to the `gh` CLI,
 * inheriting the caller's own `gh auth` session — zero config) and
 * `RestForgeClient` (plain `fetch` against the GitHub REST API using
 * `GITHUB_TOKEN` — no new npm dependency). `createForgeClient` picks
 * whichever is usable; when neither is, callers get a client that always
 * reports itself unreachable, which the reconciliation rule already knows
 * how to fall back from (PLAN.md §1.3 step 5: memo, else `unknown(offline)`,
 * never a guess).
 */

import { z } from "zod"
import { execArgv } from "./exec.js"

/** A pull/merge request as the reconciliation rule needs to see it. */
export interface ForgePullRequestRef {
  number: number
  state: "open" | "closed"
  merged: boolean
  mergedAt: string | null
  headRefName: string
  headRefOid: string
}

/**
 * Thrown by a `ForgeClient` method when the forge could not be reached or
 * queried at all (network failure, missing/unauthenticated CLI, non-2xx HTTP
 * response). Never thrown for a legitimate empty result (a branch/commit
 * with no PRs is a valid, resolvable answer — `[]`, not an error). Callers
 * treat this as PLAN.md §1.3 step 5: "never guess."
 */
export class ForgeUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "ForgeUnavailableError"
  }
}

export interface ForgeClient {
  /** PRs/MRs (any state) whose head branch is exactly `branch`. */
  pullRequestsForBranch(branch: string): Promise<ForgePullRequestRef[]>
  /**
   * PRs/MRs associated with a specific commit SHA — the rename/retarget-proof
   * signal (PLAN.md §1.3 step 2b): finds the PR even if the branch was
   * renamed or deleted before merge.
   */
  pullRequestsForCommit(sha: string): Promise<ForgePullRequestRef[]>
  /**
   * Ensure `oid` (a PR's `headRefOid`) is present in the local object
   * database, fetching `refs/pull/<number>/head` if it isn't. Always
   * fetchable even after the head branch was deleted on the remote
   * (PLAN.md §1.3 step 2, verified for #273/#312/#325/#271).
   */
  ensurePullHeadFetched(prNumber: number, oid: string): Promise<void>
}

/** A client that always reports itself unreachable — the "no gh, no token" case. */
export class UnreachableForgeClient implements ForgeClient {
  constructor(private readonly reason: string) {}
  async pullRequestsForBranch(): Promise<ForgePullRequestRef[]> {
    throw new ForgeUnavailableError(this.reason)
  }
  async pullRequestsForCommit(): Promise<ForgePullRequestRef[]> {
    throw new ForgeUnavailableError(this.reason)
  }
  async ensurePullHeadFetched(): Promise<void> {
    throw new ForgeUnavailableError(this.reason)
  }
}

// ── gh CLI implementation ───────────────────────────────────────────────

const ghPrListItemSchema = z.object({
  number: z.number(),
  state: z.string(),
  headRefName: z.string(),
  headRefOid: z.string(),
  mergedAt: z.string().nullable(),
})
type GhPrListItem = z.infer<typeof ghPrListItemSchema>
const ghPrListSchema = z.array(ghPrListItemSchema)

function normalizeGhPrListItem(item: GhPrListItem): ForgePullRequestRef {
  const state = item.state.toUpperCase()
  return {
    number: item.number,
    state: state === "OPEN" ? "open" : "closed",
    merged: state === "MERGED" || item.mergedAt !== null,
    mergedAt: item.mergedAt,
    headRefName: item.headRefName,
    headRefOid: item.headRefOid,
  }
}

const ghApiCommitPullSchema = z.object({
  number: z.number(),
  state: z.string(),
  merged_at: z.string().nullable(),
  head: z.object({ ref: z.string(), sha: z.string() }),
})
type GhApiCommitPull = z.infer<typeof ghApiCommitPullSchema>
const ghApiCommitPullListSchema = z.array(ghApiCommitPullSchema)

function normalizeGhApiCommitPull(item: GhApiCommitPull): ForgePullRequestRef {
  return {
    number: item.number,
    state: item.state === "open" ? "open" : "closed",
    merged: item.merged_at !== null,
    mergedAt: item.merged_at,
    headRefName: item.head.ref,
    headRefOid: item.head.sha,
  }
}

/**
 * GitHub's REST API answers "commit unknown to this repo" (e.g. a local
 * commit that was never pushed) with HTTP 422 on `commits/:sha/pulls` —
 * empirically verified against a real unpushed worktree commit, not the 404
 * the endpoint's own docs imply. `gh api` surfaces the status in its stderr
 * as `(HTTP nnn)`. Both 404 and 422 here mean the same legitimate thing:
 * zero associated PRs, not "the forge is unreachable" — never guess step 5
 * on a genuinely empty, well-formed answer.
 */
function isCommitNotFoundError(output: string): boolean {
  return /\(HTTP (404|422)\)/.test(output)
}

/** Runs `gh` in `repoRoot` so it auto-detects owner/repo from the `origin` remote there. */
export class GhCliForgeClient implements ForgeClient {
  constructor(private readonly repoRoot: string) {}

  private async runRaw(args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    try {
      return await execArgv("gh", args, this.repoRoot)
    } catch (err) {
      throw new ForgeUnavailableError(
        `gh ${args.join(" ")} could not be run: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
  }

  private async run(args: readonly string[]): Promise<string> {
    const result = await this.runRaw(args)
    if (result.exitCode !== 0) {
      throw new ForgeUnavailableError(
        `gh ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
      )
    }
    return result.stdout
  }

  private parseOutput<T>(stdout: string, schema: z.ZodType<T[]>, args: readonly string[]): T[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(stdout)
    } catch (err) {
      throw new ForgeUnavailableError(
        `gh ${args.join(" ")} produced non-JSON output: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    const result = schema.safeParse(parsed)
    if (!result.success) {
      throw new ForgeUnavailableError(`gh ${args.join(" ")} output did not match the expected shape`)
    }
    return result.data
  }

  async pullRequestsForBranch(branch: string): Promise<ForgePullRequestRef[]> {
    const args = [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "number,state,headRefName,headRefOid,mergedAt",
    ]
    const stdout = await this.run(args)
    return this.parseOutput(stdout, ghPrListSchema, args).map(normalizeGhPrListItem)
  }

  async pullRequestsForCommit(sha: string): Promise<ForgePullRequestRef[]> {
    const args = ["api", `repos/{owner}/{repo}/commits/${sha}/pulls`]
    const result = await this.runRaw(args)
    if (result.exitCode !== 0) {
      if (isCommitNotFoundError(result.stderr) || isCommitNotFoundError(result.stdout)) return []
      throw new ForgeUnavailableError(
        `gh ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
      )
    }
    return this.parseOutput(result.stdout, ghApiCommitPullListSchema, args).map(normalizeGhApiCommitPull)
  }

  async ensurePullHeadFetched(prNumber: number, oid: string): Promise<void> {
    const check = await execArgv("git", ["-C", this.repoRoot, "cat-file", "-e", `${oid}^{commit}`], this.repoRoot)
    if (check.exitCode === 0) return
    const fetch = await execArgv(
      "git",
      ["-C", this.repoRoot, "fetch", "origin", `refs/pull/${prNumber}/head`],
      this.repoRoot,
    )
    if (fetch.exitCode !== 0) {
      throw new ForgeUnavailableError(
        `git fetch origin refs/pull/${prNumber}/head failed: ${fetch.stderr.trim() || fetch.stdout.trim()}`,
      )
    }
  }
}

// ── GITHUB_TOKEN REST fallback (no new npm dependency — global fetch) ───

const restPullRequestSchema = z.object({
  number: z.number(),
  state: z.string(),
  merged_at: z.string().nullable(),
  head: z.object({ ref: z.string(), sha: z.string() }),
})
type RestPullRequest = z.infer<typeof restPullRequestSchema>
const restPullRequestListSchema = z.array(restPullRequestSchema)

function normalizeRestPr(item: RestPullRequest): ForgePullRequestRef {
  return {
    number: item.number,
    state: item.state === "open" ? "open" : "closed",
    merged: item.merged_at !== null,
    mergedAt: item.merged_at,
    headRefName: item.head.ref,
    headRefOid: item.head.sha,
  }
}

/** Parse `owner/repo` out of a `git remote get-url origin` value (ssh or https form). */
export function parseGithubOwnerRepo(remoteUrl: string): { owner: string; repo: string } | null {
  const ssh = remoteUrl.match(/^git@github\.com:([^/]+)\/(.+?)(\.git)?$/)
  if (ssh?.[1] && ssh[2]) return { owner: ssh[1], repo: ssh[2] }
  const https = remoteUrl.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(\.git)?\/?$/)
  if (https?.[1] && https[2]) return { owner: https[1], repo: https[2] }
  return null
}

export class RestForgeClient implements ForgeClient {
  constructor(
    private readonly owner: string,
    private readonly repo: string,
    private readonly repoRoot: string,
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agentproto-worktree-status",
    }
  }

  private async get(path: string): Promise<Response> {
    try {
      return await this.fetchFn(`https://api.github.com${path}`, { headers: this.headers() })
    } catch (err) {
      throw new ForgeUnavailableError(
        `GitHub REST request to ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
  }

  private async pullRequestList(res: Response): Promise<ForgePullRequestRef[]> {
    const body: unknown = await res.json()
    const result = restPullRequestListSchema.safeParse(body)
    if (!result.success) {
      throw new ForgeUnavailableError(`GitHub REST response did not match the expected PR list shape`)
    }
    return result.data.map(normalizeRestPr)
  }

  async pullRequestsForBranch(branch: string): Promise<ForgePullRequestRef[]> {
    const res = await this.get(
      `/repos/${this.owner}/${this.repo}/pulls?head=${this.owner}:${encodeURIComponent(branch)}&state=all&per_page=100`,
    )
    if (!res.ok) {
      throw new ForgeUnavailableError(`GitHub REST pulls?head= failed: ${res.status} ${res.statusText}`)
    }
    return this.pullRequestList(res)
  }

  async pullRequestsForCommit(sha: string): Promise<ForgePullRequestRef[]> {
    const res = await this.get(`/repos/${this.owner}/${this.repo}/commits/${sha}/pulls?per_page=100`)
    // 404 is what the endpoint's docs imply for an unknown commit; 422 is what
    // it empirically returns for one that was never pushed (verified live).
    // Both mean the same legitimate thing: zero associated PRs.
    if (res.status === 404 || res.status === 422) return []
    if (!res.ok) {
      throw new ForgeUnavailableError(`GitHub REST commits/:sha/pulls failed: ${res.status} ${res.statusText}`)
    }
    return this.pullRequestList(res)
  }

  async ensurePullHeadFetched(prNumber: number, oid: string): Promise<void> {
    const check = await execArgv("git", ["-C", this.repoRoot, "cat-file", "-e", `${oid}^{commit}`], this.repoRoot)
    if (check.exitCode === 0) return
    const fetch2 = await execArgv(
      "git",
      ["-C", this.repoRoot, "fetch", "origin", `refs/pull/${prNumber}/head`],
      this.repoRoot,
    )
    if (fetch2.exitCode !== 0) {
      throw new ForgeUnavailableError(
        `git fetch origin refs/pull/${prNumber}/head failed: ${fetch2.stderr.trim() || fetch2.stdout.trim()}`,
      )
    }
  }
}

/**
 * Cheap "is `gh` on PATH and authenticated" probe — avoids a slow failure per
 * branch.
 *
 * Deliberately `gh auth token`, not `gh auth status`: `status` audits **every**
 * configured account and exits non-zero when *any* of them is broken, even
 * while the active credential works fine for real calls. A single stale keyring
 * entry for a second account is enough to make it exit 1 — and because a false
 * negative here lands on `UnreachableForgeClient`, every worktree's integration
 * silently degrades to `unknown(offline)` and `worktree gc` holds everything it
 * would otherwise reclaim. Observed exactly that: `gh auth status` exiting 1 on
 * a stale account while `gh pr list` and `gh api rate_limit` both answered
 * normally.
 *
 * `gh auth token` answers the question this probe actually asks — "is gh on
 * PATH with a usable credential" — and does it locally, with no network call.
 * It cannot prove the token is still valid server-side, but neither could
 * `status`: a token revoked upstream fails at call time either way, which is
 * exactly what `ForgeUnavailableError` and the memo/`unknown(offline)` fallback
 * already handle.
 */
async function ghIsUsable(repoRoot: string): Promise<boolean> {
  try {
    const res = await execArgv("gh", ["auth", "token"], repoRoot)
    return res.exitCode === 0 && res.stdout.trim() !== ""
  } catch {
    return false
  }
}

/**
 * Pick the best available `ForgeClient` for `repoRoot`: `gh` CLI first (zero
 * config, inherits the caller's own auth), else `GITHUB_TOKEN` REST, else a
 * client that always reports unreachable — the reconciliation rule already
 * knows how to fall back from that (memo, else `unknown(offline)`).
 */
export async function createForgeClient(repoRoot: string): Promise<ForgeClient> {
  if (await ghIsUsable(repoRoot)) return new GhCliForgeClient(repoRoot)

  const token = process.env.GITHUB_TOKEN
  if (token) {
    const remote = await execArgv("git", ["-C", repoRoot, "remote", "get-url", "origin"], repoRoot)
    const parsed = remote.exitCode === 0 ? parseGithubOwnerRepo(remote.stdout.trim()) : null
    if (parsed) return new RestForgeClient(parsed.owner, parsed.repo, repoRoot, token)
  }

  return new UnreachableForgeClient(
    "no usable forge client: `gh` is not installed/authenticated and GITHUB_TOKEN is not set (or origin isn't a GitHub remote)",
  )
}
