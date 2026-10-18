/**
 * Types for the pr-outcome collector.
 *
 * ANECDOTAL-ONLY RULE: pr-outcome records are illustrative statistics about
 * how past agent-assisted PRs turned out. They are NEVER an input to routing
 * rules, quotas, or any automated decision. Every record's `basis` is
 * "observed"; nothing is inferred or invented. Any field that is not
 * observable in the source data is left undefined.
 */

/** Provenance parsed back from a rendered `@agentproto-bot` PR footer. */
export interface PrProvenance {
  sessionId?: string
  label?: string
  adapter?: string
  authMode?: string
  authProfile?: string
  model?: string
  sandboxId?: string
  parentSessionId?: string
  /** Tokens in; parsed from strings like `12.3k in` (rounded through the k-notation, see parse-footer). */
  tokensIn?: number
  tokensOut?: number
  costUsd?: number
  costSource?: string
  runId?: string
  runUrl?: string
  sha?: string
  kind?: string
  host?: string
  cwdLabel?: string
}

export interface GhPull {
  number: number
  state: string
  merged: boolean
  mergedAt?: string
  createdAt: string
  body?: string
  title: string
  headRefName: string
  /** Head commit of the PR branch; check-runs are read from it. */
  headSha?: string
  /** Merge (or squash) commit on the base branch; `This reverts commit <sha>` is matched against it. */
  mergeCommitSha?: string
}

export interface GhReview {
  authorLogin: string
  /** "Bot" for GitHub app/bot authors, "User" otherwise. */
  authorType: "User" | "Bot"
  state: string
  submittedAt?: string
}

export interface GhComment {
  authorLogin: string
  authorType: "User" | "Bot"
  createdAt: string
}

export interface GhCommit {
  committedDate: string
  message: string
}

export interface GhCheck {
  name: string
  conclusion: string
}

export interface PrOutcome {
  repo: string
  number: number
  provenance?: PrProvenance
  reviews: { human: number; bot: number }
  comments: { human: number; bot: number }
  changesRequested: boolean
  commitsAfterFirstReview: number
  ciFailures: number
  reverted: boolean
  state: string
  mergedAt?: string
  timeToMergeMinutes?: number
  collectedAt: string
  basis: "observed"
}

/** A PR the collector skipped, plus why. Collect-level concern. */
export interface SkippedOutcome {
  repo: string
  number?: number
  reason: string
}

