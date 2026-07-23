/**
 * GhPrSourceAdapter — a PrSourcePort backed by the GitHub CLI (`gh`). This is
 * how the local `corpus` runtime resolves a repo query to its pull requests:
 * the SAME `gh` binary the rest of the repo already talks to GitHub through
 * (see the daemon's `gh pr create` lane), reusing the user's existing `gh`
 * auth — no new HTTP client, no token plumbing in the corpus layer.
 *
 *   query → gh pr list --repo <repo> --json number …    (enumerate)
 *         → gh pr view <n> --repo <repo> --json …        (per-PR detail)
 *
 * Per-PR resilience lives HERE, not in the pure importer: a single PR that
 * `gh pr view` cannot fetch (deleted, permission) is skipped with a stderr
 * notice and simply not yielded, so one bad PR never aborts the batch. A
 * failure to even *list* PRs (bad repo, `gh` unauthenticated) throws — that is
 * a hard batch abort the importer surfaces.
 *
 * The `gh` invocation is injected as `run` so the adapter is unit-testable with
 * a fake runner — no binary, no network. All `gh` JSON is parsed through zod;
 * no `any` crosses the boundary.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { z } from "zod"
import type {
  PrDoc,
  PrQuery,
  PrReviewComment,
  PrSourcePort,
} from "@agentproto/corpus"

const execFileAsync = promisify(execFile)

/** Run a `gh` subcommand and resolve its stdout. Injectable for tests. */
export type GhRunner = (args: readonly string[]) => Promise<string>

export interface GhPrSourceAdapterOptions {
  /** Defaults to a `gh` subprocess runner. */
  readonly run?: GhRunner
  /** Path to the `gh` binary (default: "gh" on PATH). */
  readonly ghBin?: string
}

// ── gh JSON shapes (only the fields we consume) ─────────────────────

const GH_ACTOR = z
  .object({ login: z.string().optional(), name: z.string().optional() })
  .loose()

const GH_PR_LIST_ITEM = z.object({ number: z.number() }).loose()
const GH_PR_LIST = z.array(GH_PR_LIST_ITEM)

const GH_COMMENT = z
  .object({
    author: GH_ACTOR.nullish(),
    body: z.string().optional(),
    path: z.string().optional(),
    createdAt: z.string().optional(),
    submittedAt: z.string().optional(),
  })
  .loose()

const GH_FILE = z
  .object({
    path: z.string(),
    additions: z.number().optional(),
    deletions: z.number().optional(),
  })
  .loose()

const GH_PR_VIEW = z
  .object({
    number: z.number(),
    title: z.string().optional(),
    body: z.string().optional(),
    author: GH_ACTOR.nullish(),
    url: z.string().optional(),
    state: z.string().optional(),
    mergedAt: z.string().nullish(),
    reviews: z.array(GH_COMMENT).optional(),
    comments: z.array(GH_COMMENT).optional(),
    reviewRequests: z.array(GH_ACTOR).optional(),
    additions: z.number().optional(),
    deletions: z.number().optional(),
    changedFiles: z.number().optional(),
    files: z.array(GH_FILE).optional(),
  })
  .loose()

const VIEW_FIELDS = [
  "number",
  "title",
  "body",
  "author",
  "url",
  "state",
  "mergedAt",
  "reviews",
  "comments",
  "reviewRequests",
  "additions",
  "deletions",
  "changedFiles",
  "files",
].join(",")

export class GhPrSourceAdapter implements PrSourcePort {
  private readonly run: GhRunner

  constructor(opts: GhPrSourceAdapterOptions = {}) {
    this.run = opts.run ?? defaultGhRunner(opts.ghBin ?? "gh")
  }

  async *listPullRequests(query: PrQuery): AsyncIterable<PrDoc> {
    const numbers = await this.resolveNumbers(query)
    for (const n of numbers) {
      let pr: PrDoc | null
      try {
        pr = await this.viewPr(query, n)
      } catch (e) {
        // Per-PR failure → skip, keep the batch alive.
        process.stderr.write(
          `corpus: skipping ${query.repo}#${n} — ${msg(e)}\n`
        )
        continue
      }
      if (pr) yield pr
    }
  }

  /** Resolve the query to a concrete, capped list of PR numbers. */
  private async resolveNumbers(query: PrQuery): Promise<number[]> {
    const cap = query.maxPRs ?? 1000
    if (query.prNumbers && query.prNumbers.length > 0) {
      return query.prNumbers.slice(0, cap)
    }
    const args = [
      "pr",
      "list",
      "--repo",
      query.repo,
      "--state",
      "all",
      "--limit",
      String(cap),
      "--json",
      "number",
    ]
    if (query.since) args.push("--search", `updated:>=${query.since}`)
    const out = await this.run(args)
    // `gh` sorts newest-first; import oldest-first so numbering reads naturally.
    return GH_PR_LIST.parse(parseJson(out))
      .map(item => item.number)
      .sort((a, b) => a - b)
  }

  /** Fetch one PR's detail and shape it into a PrDoc, or null if empty. */
  private async viewPr(query: PrQuery, number: number): Promise<PrDoc | null> {
    const out = await this.run([
      "pr",
      "view",
      String(number),
      "--repo",
      query.repo,
      "--json",
      VIEW_FIELDS,
    ])
    const v = GH_PR_VIEW.parse(parseJson(out))

    const reviewComments = toReviewComments([
      ...(v.reviews ?? []),
      ...(v.comments ?? []),
    ])
    const reviewers = uniqueLogins([
      ...(v.reviews ?? []).map(r => r.author),
      ...(v.reviewRequests ?? []),
    ])

    const doc: PrDoc = {
      number: v.number,
      title: v.title ?? "",
      body: v.body ?? "",
      ...(actorLabel(v.author) ? { author: actorLabel(v.author) } : {}),
      ...(v.url ? { url: v.url } : {}),
      ...(v.state ? { state: v.state.toLowerCase() } : {}),
      ...(v.mergedAt ? { mergedAt: v.mergedAt } : {}),
      ...(reviewers.length > 0 ? { reviewers } : {}),
      ...(reviewComments.length > 0 ? { reviewComments } : {}),
      ...(query.includeDiffSummary ? { diffSummary: buildDiffSummary(v) } : {}),
    }
    return doc
  }
}

// ── Pure helpers (exported for direct unit testing) ─────────────────

type GhActor = z.infer<typeof GH_ACTOR>
type GhComment = z.infer<typeof GH_COMMENT>
type GhPrView = z.infer<typeof GH_PR_VIEW>

function actorLabel(actor: GhActor | null | undefined): string | undefined {
  const label = actor?.login ?? actor?.name
  return label && label.length > 0 ? label : undefined
}

export function toReviewComments(
  raw: readonly GhComment[]
): PrReviewComment[] {
  const out: PrReviewComment[] = []
  for (const c of raw) {
    const body = (c.body ?? "").trim()
    if (!body) continue
    const author = actorLabel(c.author)
    const at = c.submittedAt ?? c.createdAt
    out.push({
      body,
      ...(author ? { author } : {}),
      ...(c.path ? { path: c.path } : {}),
      ...(at ? { at } : {}),
    })
  }
  return out
}

function uniqueLogins(actors: readonly (GhActor | null | undefined)[]): string[] {
  const seen = new Set<string>()
  for (const a of actors) {
    const label = actorLabel(a)
    if (label) seen.add(label)
  }
  return [...seen]
}

/** A bounded diffstat summary from the PR's file list + totals. */
export function buildDiffSummary(v: GhPrView): string {
  const lines: string[] = []
  for (const f of v.files ?? []) {
    const add = f.additions ?? 0
    const del = f.deletions ?? 0
    lines.push(`${f.path} | +${add} -${del}`)
  }
  const totals =
    v.changedFiles !== undefined
      ? `${v.changedFiles} files changed, +${v.additions ?? 0} -${v.deletions ?? 0}`
      : undefined
  return [...(totals ? [totals] : []), ...lines].join("\n")
}

function parseJson(out: string): unknown {
  const trimmed = out.trim()
  if (!trimmed) return []
  return JSON.parse(trimmed)
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function defaultGhRunner(bin: string): GhRunner {
  return async (args: readonly string[]): Promise<string> => {
    const { stdout } = await execFileAsync(bin, [...args], {
      maxBuffer: 32 * 1024 * 1024,
    })
    return stdout
  }
}
