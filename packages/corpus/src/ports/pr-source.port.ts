/**
 * PrSourcePort — the "pull-request query → PR documents" boundary the
 * PrReviewImporter consumes. Symmetric with FetcherPort (URL → text) and
 * ConversationSourcePort (ref → turns): it keeps the importer PURE and
 * forge-agnostic. The importer decides *what* to import (slugging, the
 * rendered body shape, the dedup hash, provenance metadata); the port
 * supplies the one capability that is environment-bound — resolving a
 * repo query to its pull requests, wherever they live.
 *
 * Structural interface, NOT nominal — any object of this shape satisfies
 * it. Concrete implementations live where the PRs live:
 *
 *   - a `gh`/GitHub-REST adapter (corpus-cli): the reference impl.
 *   - a self-hosted forge over its own API (GitLab, Gitea, …).
 *   - a fake (tests): canned PrDoc[] per query.
 *
 * The port yields already-fetched `PrDoc`s. A single PR that cannot be
 * fetched (deleted, permission) is the adapter's concern — it simply does
 * not yield that PR (a skip), never a null in the stream. A *thrown* error
 * is reserved for a hard failure (auth, forge unreachable); the importer
 * contains it so a batch survives what was streamed before the throw.
 */

/** One comment on a PR — the description-level body or a review-thread reply. */
export interface PrReviewComment {
  /** Comment author login, when known. */
  readonly author?: string
  /** The comment text, already flattened to plain text/markdown by the port. */
  readonly body: string
  /** File path the review comment is anchored to, for inline-thread comments. */
  readonly path?: string
  /** ISO-8601 timestamp, when known — for provenance + ordering. */
  readonly at?: string
}

/**
 * One resolved pull request — the raw material a PrReviewImporter turns into
 * a `knowledge.source`. Title + body + review discussion + (optionally) a
 * diff summary are the reviewable substance; the rest is provenance.
 */
export interface PrDoc {
  /** PR number within the repo — becomes the source slug suffix. */
  readonly number: number
  /** PR title. */
  readonly title: string
  /** PR description (body), already flattened to plain text/markdown. */
  readonly body: string
  /** PR author login, when known. */
  readonly author?: string
  /** The PR's web URL, for source provenance. */
  readonly url?: string
  /** Lifecycle state — "open" | "closed" | "merged", when known. */
  readonly state?: string
  /** ISO-8601 merge timestamp, when the PR was merged. */
  readonly mergedAt?: string
  /** Reviewer logins that participated, when known. */
  readonly reviewers?: readonly string[]
  /** Review-thread + discussion comments in chronological order. */
  readonly reviewComments?: readonly PrReviewComment[]
  /** Optional diff summary (diffstat / unified excerpt), when requested. */
  readonly diffSummary?: string
  /** BCP-47 language hint, when the forge knows it. */
  readonly language?: string
}

/** The query a PrReviewImporter hands the port to enumerate pull requests. */
export interface PrQuery {
  /** Repository, "owner/name" (e.g. "agentproto/ts"). Required. */
  readonly repo: string
  /** Explicit PR numbers to import. Takes precedence over `since`. */
  readonly prNumbers?: readonly number[]
  /** ISO-8601 lower bound — import PRs updated at/after this instant. */
  readonly since?: string
  /** When true, the port includes a diff summary on each PrDoc. */
  readonly includeDiffSummary?: boolean
  /** Cap on the number of PRs the port yields. */
  readonly maxPRs?: number
}

export interface PrSourcePort {
  /**
   * Enumerate the pull requests matching a query. Async iterator so the
   * importer can stream + back-pressure on large repos. Each yielded PrDoc
   * carries everything the importer needs to shape one ImportedSource.
   */
  listPullRequests(query: PrQuery): AsyncIterable<PrDoc>
}
