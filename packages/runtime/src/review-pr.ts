/**
 * PR follow-up for review attestations — the host side of `review_pr`.
 *
 * A review attests a git range; whether that range became a PR, and what
 * happened to the PR afterwards, is only knowable later. This module asks
 * GitHub through the daemon host's authed `gh` CLI (shelled out — no HTTP
 * client, no token handling of our own):
 *
 *   - {@link findPrForCommit}: `headSha → PR` via
 *     `gh api repos/{owner}/{repo}/commits/{sha}/pulls`;
 *   - {@link fetchPrStatus}: the PR's state + reviews (+ check runs on the
 *     PR head, best-effort) as one {@link PrStatusSnapshot}.
 *
 * Every failure is a {@link PrLookupError} with a stable `code` — `gh`
 * missing, `gh` failing (auth, network, 404), a non-GitHub remote, no PR for
 * the commit — so the tool can return it as structured data instead of
 * throwing.
 */

import { execFile } from "node:child_process"
import type { ReviewPrRef } from "@agentproto/review"
import type { PrStatusSnapshot } from "./review-ledger.js"

export type PrLookupErrorCode = "gh_unavailable" | "gh_failed" | "unsupported_remote" | "no_pr"

export class PrLookupError extends Error {
  constructor(
    readonly code: PrLookupErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "PrLookupError"
  }
}

/** Runs `gh <args>` and resolves its stdout. */
export type GhRunner = (args: readonly string[]) => Promise<string>

/** The real runner: `gh` from the daemon's PATH. A missing binary is
 *  `gh_unavailable`; any non-zero exit is `gh_failed` with gh's stderr. */
export const execGh: GhRunner = (args) =>
  new Promise((resolvePromise, reject) => {
    execFile("gh", [...args], { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === "ENOENT") {
          reject(new PrLookupError("gh_unavailable", "the GitHub CLI (`gh`) is not installed or not on the daemon's PATH"))
          return
        }
        const detail = String(stderr || err.message).trim()
        reject(new PrLookupError("gh_failed", `gh ${args.join(" ")} failed: ${detail}`))
        return
      }
      resolvePromise(String(stdout))
    })
  })

/** `github.com/owner/name` → `owner/name`; `undefined` for any other host.
 *  Also accepts the multi-account SSH host-alias convention
 *  (`git@github.com-work:owner/name` normalizes to `github.com-work/owner/name`). */
export function githubRepoOf(repoRemote: string): string | undefined {
  const m = repoRemote.match(/^(?:ssh\.)?github\.com(?:-[A-Za-z0-9._-]+)?\/([^/]+\/[^/]+)$/)
  return m?.[1]
}

/** Is `repoRemote` (as recorded in the ledger) the GitHub repo `owner/name`? */
export const isRemoteOf = (repoRemote: string, repo: string): boolean => githubRepoOf(repoRemote) === repo

/** Parse `https://github.com/owner/name/pull/42` (trailing path/query ok). */
export function parsePrUrl(url: string): { repo: string; number: number } | undefined {
  const m = url.trim().match(/^(?:https?:\/\/)?github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/)
  return m ? { repo: m[1]!, number: Number(m[2]) } : undefined
}

export const prRef = (repo: string, number: number): ReviewPrRef => ({
  provider: "github",
  repo,
  number,
  url: `https://github.com/${repo}/pull/${number}`,
})

async function ghJson<T>(gh: GhRunner, path: string): Promise<T> {
  const out = await gh(["api", "-H", "Accept: application/vnd.github+json", path])
  try {
    return JSON.parse(out) as T
  } catch {
    throw new PrLookupError("gh_failed", `gh api ${path} returned non-JSON output`)
  }
}

interface GhPull {
  number: number
  html_url?: string
  state: "open" | "closed"
  merged_at?: string | null
  head?: { sha?: string }
}

/** The PR `headSha` belongs to, or `undefined` when GitHub knows none.
 *  Prefers a PR whose head IS `headSha`, then an open one, then the first. */
export async function findPrForCommit(gh: GhRunner, repo: string, headSha: string): Promise<ReviewPrRef | undefined> {
  const pulls = await ghJson<GhPull[]>(gh, `repos/${repo}/commits/${headSha}/pulls?per_page=100`)
  if (!Array.isArray(pulls) || pulls.length === 0) return undefined
  const pick =
    pulls.find((p) => p.head?.sha === headSha) ?? pulls.find((p) => p.state === "open") ?? pulls[0]!
  return { ...prRef(repo, pick.number), ...(pick.html_url ? { url: pick.html_url } : {}) }
}

/** The PR's head sha (for matching a `prUrl` to ledger entries). */
export async function prHeadSha(gh: GhRunner, repo: string, number: number): Promise<string | undefined> {
  const pull = await ghJson<GhPull>(gh, `repos/${repo}/pulls/${number}`)
  return pull.head?.sha
}

/** One status snapshot of `pr`: state, reviews, and (best-effort — omitted
 *  when that call fails) the check runs on the PR's current head. */
export async function fetchPrStatus(gh: GhRunner, pr: ReviewPrRef, now: () => Date = () => new Date()): Promise<PrStatusSnapshot> {
  const pull = await ghJson<GhPull>(gh, `repos/${pr.repo}/pulls/${pr.number}`)
  const rawReviews = await ghJson<Array<{ user?: { login?: string } | null; state?: string; submitted_at?: string }>>(
    gh,
    `repos/${pr.repo}/pulls/${pr.number}/reviews?per_page=100`,
  )
  let checks: PrStatusSnapshot["checks"]
  if (pull.head?.sha) {
    try {
      const runs = await ghJson<{ check_runs?: Array<{ name?: string; conclusion?: string | null }> }>(
        gh,
        `repos/${pr.repo}/commits/${pull.head.sha}/check-runs?per_page=100`,
      )
      checks = (runs.check_runs ?? []).map((c) => ({ name: String(c.name ?? ""), conclusion: c.conclusion ?? null }))
    } catch {
      checks = undefined
    }
  }
  return {
    fetchedAt: now().toISOString(),
    state: pull.merged_at ? "merged" : pull.state === "open" ? "open" : "closed",
    reviews: (Array.isArray(rawReviews) ? rawReviews : []).map((r) => ({
      login: r.user?.login ?? "",
      state: r.state ?? "",
      submittedAt: r.submitted_at ?? "",
    })),
    ...(checks ? { checks } : {}),
    ...(pull.head?.sha ? { headSha: pull.head.sha } : {}),
  }
}

export const toPrLookupError = (err: unknown): PrLookupError =>
  err instanceof PrLookupError ? err : new PrLookupError("gh_failed", err instanceof Error ? err.message : String(err))
