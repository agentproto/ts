/**
 * PrReviewImporter — turns a repo's pull requests into corpus sources by
 * rendering each PR (description + review discussion + optional diff summary)
 * to a reviewable transcript through an injected PrSourcePort. The importer is
 * pure: it slugs, hashes, and shapes ImportedSource; the port supplies the
 * environment-bound "repo query → PRs" capability (a `gh`/GitHub-REST adapter,
 * another forge, a fake).
 *
 * This is the seam for pr-review→knowledge distill — the resulting sources feed
 * DistillRunner exactly like web and conversation sources do (the pipeline is
 * provenance-agnostic). A merged PR + its review thread is a dense record of a
 * decision and the critique that shaped it, so the distilled entries land as
 * `pattern`/`critique`/`summary` — the `pr-review` blend layer.
 *
 * Config (target.config):
 *   - repo: string                       — required. "owner/name".
 *   - prNumbers?: number[]               — explicit PRs; takes precedence.
 *   - since?: string                     — ISO-8601 lower bound (updated-at).
 *   - includeDiffSummary?: boolean       — ask the port for a diff summary.
 *   - tags?: string[]                    — applied to every source.
 *   - language?: string                  — fallback BCP-47.
 *   - maxPRs?: number                    — defaults to 1000.
 *
 * Pure kit code — consumes PrSourcePort, no forge/HTTP dependency. Slug:
 * `<repo>-pr-<n>`. Hash: sha256 of the rendered body, so an unchanged PR
 * re-import dedups in ImporterRunner. Authority: "secondary" — a PR review is
 * derived commentary about the code, not the primary artifact itself.
 */

import { createHash } from "node:crypto"
import { slugify, uniqueSlug } from "../util/slug.js"
import { normalizeLanguageTag } from "../util/language.js"
import type {
  PrDoc,
  PrQuery,
  PrReviewComment,
  PrSourcePort,
} from "../ports/pr-source.port.js"
import type {
  CorpusImporter,
  ImportedSource,
  ImporterTarget,
} from "./types.js"

export interface PrReviewImporterOptions {
  readonly source: PrSourcePort
}

interface PrReviewConfig {
  readonly repo: string
  readonly prNumbers?: readonly number[]
  readonly since?: string
  readonly includeDiffSummary?: boolean
  readonly tags?: readonly string[]
  readonly language?: string
  readonly maxPRs?: number
}

export class PrReviewImporter implements CorpusImporter {
  readonly id = "pr-review"
  readonly label = "PR review"

  constructor(private readonly opts: PrReviewImporterOptions) {}

  async *enumerate(target: ImporterTarget): AsyncIterable<ImportedSource> {
    const config = parseConfig(target.config)
    const maxPRs = config.maxPRs ?? 1000
    const seenSlugs = new Set<string>()
    let yielded = 0

    const query: PrQuery = {
      repo: config.repo,
      ...(config.prNumbers ? { prNumbers: config.prNumbers } : {}),
      ...(config.since ? { since: config.since } : {}),
      ...(config.includeDiffSummary ? { includeDiffSummary: true } : {}),
      maxPRs,
    }

    // The port streams already-fetched PRs; a single unfetchable PR is a
    // silent skip on the adapter side, never a null in the stream. A *thrown*
    // error (auth, forge unreachable) must NOT lose the PRs streamed so far —
    // the throw would propagate out of this generator. Drive the iterator by
    // hand so a mid-stream throw is contained: the batch keeps what it got and
    // the importer is resumable, so a re-run retries the rest.
    const iterator = this.opts.source
      .listPullRequests(query)
      [Symbol.asyncIterator]()
    while (yielded < maxPRs) {
      let step: IteratorResult<PrDoc>
      try {
        step = await iterator.next()
      } catch {
        break
      }
      if (step.done) break
      const pr = step.value

      const body = renderPr(pr)
      if (!body) continue // nothing reviewable — skip

      const repoSlug = slugify(config.repo, { fallback: "repo" })
      const slug = uniqueSlug(`${repoSlug}-pr-${pr.number}`, seenSlugs)
      const language = normalizeLanguageTag(pr.language ?? config.language)

      yield {
        slug,
        title: (pr.title || `PR #${pr.number}`).slice(0, 200),
        contentHash: sha256(body),
        body,
        ...(pr.url ? { originalUrl: pr.url } : {}),
        authority: "secondary",
        ...(language ? { language } : {}),
        ...(config.tags && config.tags.length > 0 ? { tags: config.tags } : {}),
        corpusMetadata: {
          provenanceKind: "imported-from-pr",
          repo: config.repo,
          prNumber: pr.number,
          ...(pr.author ? { author: pr.author } : {}),
          ...(pr.state ? { state: pr.state } : {}),
          ...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {}),
          ...(pr.reviewers && pr.reviewers.length > 0
            ? { reviewers: pr.reviewers }
            : {}),
        },
      }
      yielded++
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function parseConfig(raw: Readonly<Record<string, unknown>>): PrReviewConfig {
  const repo = raw.repo
  if (typeof repo !== "string" || repo.length === 0) {
    throw new Error("PrReviewImporter: config.repo is required (\"owner/name\")")
  }
  const rawNumbers = raw.prNumbers
  const prNumbers = Array.isArray(rawNumbers)
    ? rawNumbers.filter(
        (n): n is number => typeof n === "number" && Number.isFinite(n)
      )
    : undefined
  const rawTags = raw.tags
  return {
    repo,
    ...(prNumbers && prNumbers.length > 0 ? { prNumbers } : {}),
    since: typeof raw.since === "string" ? raw.since : undefined,
    includeDiffSummary: raw.includeDiffSummary === true,
    tags: Array.isArray(rawTags)
      ? rawTags.filter((x): x is string => typeof x === "string")
      : undefined,
    language: typeof raw.language === "string" ? raw.language : undefined,
    maxPRs: typeof raw.maxPRs === "number" ? raw.maxPRs : undefined,
  }
}

/**
 * Render a PR to a reviewable markdown transcript: title, description, the
 * review discussion (each comment as `Author [path]: body`), then an optional
 * diff summary. Empty sections are dropped so the distiller sees only
 * substance; a PR with no title, body, comments, or diff renders to "" and is
 * skipped by the importer.
 */
function renderPr(pr: PrDoc): string {
  const blocks: string[] = []
  const title = pr.title.trim()
  if (title) blocks.push(`# ${title}`)

  const desc = pr.body.trim()
  if (desc) blocks.push(desc)

  const comments = renderComments(pr.reviewComments ?? [])
  if (comments) blocks.push(`## Review discussion\n\n${comments}`)

  const diff = pr.diffSummary?.trim()
  if (diff) blocks.push(`## Diff summary\n\n${diff}`)

  return blocks.join("\n\n")
}

function renderComments(comments: readonly PrReviewComment[]): string {
  const out: string[] = []
  for (const c of comments) {
    const text = c.body.trim()
    if (!text) continue
    const who = c.author?.trim() || "reviewer"
    const where = c.path ? ` [${c.path}]` : ""
    out.push(`${who}${where}: ${text}`)
  }
  return out.join("\n\n")
}

function sha256(content: string): string {
  return "sha256:" + createHash("sha256").update(content).digest("hex")
}
