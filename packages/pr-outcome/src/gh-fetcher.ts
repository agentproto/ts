import { execFile } from "node:child_process"
import type { GhCheck, GhComment, GhCommit, GhPull, GhReview } from "./types.js"

/** Transport over GitHub data; the collector only sees this interface. */
export interface GhFetcher {
  listMergedPulls(repo: string): Promise<GhPull[]>
  listReviews(repo: string, number: number): Promise<GhReview[]>
  /** Conversation comments plus inline review comments. */
  listComments(repo: string, number: number): Promise<GhComment[]>
  listCommits(repo: string, number: number): Promise<GhCommit[]>
  /** Check-runs of the PR head commit. */
  listChecks(repo: string, pull: GhPull): Promise<GhCheck[]>
}

type Row = Record<string, any>
type Run = (args: string[]) => Promise<string>

/**
 * `gh api --paginate --slurp` wraps each page in an outer array, so every
 * endpoint returns pages; `flatPages` merges them. Arguments are always argv
 * arrays, never shell strings.
 */
const api = (path: string): string[] => ["api", "--paginate", "--slurp", path]

export const buildListArgs = (repo: string): string[] =>
  api(`repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`)

export const buildNumberArgs = (repo: string, n: number, part: string): string[] =>
  api(`repos/${repo}/${part === "issue-comments" ? `issues/${n}/comments` : `pulls/${n}/${part}`}?per_page=100`)

export const buildCheckArgs = (repo: string, sha: string): string[] =>
  api(`repos/${repo}/commits/${sha}/check-runs?per_page=100`)

const parsePages = (out: string): unknown[] => {
  const pages = JSON.parse(out) as unknown[]
  return Array.isArray(pages) ? pages : []
}

const flatPages = (out: string): Row[] => parsePages(out).flat() as Row[]

const flatCheckRuns = (out: string): Row[] =>
  (parsePages(out) as Array<{ check_runs?: Row[] }>).flatMap((p) => p.check_runs ?? [])

const author = (r: Row): { authorLogin: string; authorType: "User" | "Bot" } => ({
  authorLogin: (r.user?.login as string | undefined) ?? "ghost",
  authorType: r.user?.type === "Bot" ? "Bot" : "User",
})

export class GhCliFetcher implements GhFetcher {
  constructor(private readonly run: Run = defaultRun) {}

  async listMergedPulls(repo: string): Promise<GhPull[]> {
    return flatPages(await this.run(buildListArgs(repo)))
      .filter((r) => r.merged_at != null)
      .map((r) => ({
        number: r.number as number,
        state: r.state as string,
        merged: true,
        mergedAt: r.merged_at as string,
        createdAt: r.created_at as string,
        body: (r.body as string | null) ?? "",
        title: r.title as string,
        headRefName: r.head?.ref as string,
        headSha: r.head?.sha as string | undefined,
        mergeCommitSha: (r.merge_commit_sha as string | null) ?? undefined,
      }))
  }

  async listReviews(repo: string, n: number): Promise<GhReview[]> {
    return flatPages(await this.run(buildNumberArgs(repo, n, "reviews"))).map((r) => ({
      ...author(r),
      state: r.state as string,
      submittedAt: (r.submitted_at as string | null) ?? undefined,
    }))
  }

  async listComments(repo: string, n: number): Promise<GhComment[]> {
    const [conversation, inline] = await Promise.all([
      this.run(buildNumberArgs(repo, n, "issue-comments")),
      this.run(buildNumberArgs(repo, n, "comments")),
    ])
    return [...flatPages(conversation), ...flatPages(inline)].map((r) => ({
      ...author(r),
      createdAt: r.created_at as string,
    }))
  }

  async listCommits(repo: string, n: number): Promise<GhCommit[]> {
    return flatPages(await this.run(buildNumberArgs(repo, n, "commits"))).map((r) => ({
      committedDate: r.commit?.committer?.date as string,
      message: r.commit?.message as string,
    }))
  }

  async listChecks(repo: string, pull: GhPull): Promise<GhCheck[]> {
    if (!pull.headSha) return []
    return flatCheckRuns(await this.run(buildCheckArgs(repo, pull.headSha))).map((c) => ({
      name: c.name as string,
      conclusion: (c.conclusion as string | null) ?? "none",
    }))
  }
}

function defaultRun(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}
