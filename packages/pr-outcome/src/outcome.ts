import type { GhPull, GhReview, GhComment, GhCommit, GhCheck, PrOutcome } from "./types.js"

/**
 * Pure PR-outcome computation.
 * Anecdotal-only: these records are illustrative; never input to routing rules.
 * Nothing is invented: unobservable fields stay undefined.
 */

export const isBotAuthor = (authorType: "User" | "Bot", login: string): boolean =>
  authorType === "Bot" || login.endsWith("[bot]")

export interface ComputeOutcomeInput {
  repo: string
  pull: GhPull
  reviews: GhReview[]
  comments: GhComment[]
  commits: GhCommit[]
  checks: GhCheck[]
  revertedBy?: boolean
}

const FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled"])

export const countCiFailures = (checks: GhCheck[]): number =>
  checks.filter((c) => FAILURE_CONCLUSIONS.has(c.conclusion)).length

export const computeOutcome = (
  input: ComputeOutcomeInput,
  now: string = new Date().toISOString(),
): PrOutcome => {
  const { repo, pull, reviews, comments, commits, checks, revertedBy } = input

  const isBot = (a: { authorType: "User" | "Bot"; authorLogin: string }) =>
    isBotAuthor(a.authorType, a.authorLogin)

  const humanReviews = reviews.filter((r) => !isBot(r))
  const botReviews = reviews.filter(isBot)

  const firstReview = [...reviews]
    .filter((r) => r.submittedAt)
    .sort((a, b) => a.submittedAt!.localeCompare(b.submittedAt!))[0]

  const commitsAfterFirstReview = firstReview?.submittedAt
    ? commits.filter((c) => c.committedDate > firstReview.submittedAt!).length
    : 0

  const mergedAt = pull.mergedAt
  const timeToMergeMinutes =
    pull.merged && mergedAt
      ? Math.round(
          (new Date(mergedAt).getTime() - new Date(pull.createdAt).getTime()) / 60000,
        )
      : undefined

  return {
    repo,
    number: pull.number,
    provenance: undefined, // joined by caller via parseFooter
    reviews: { human: humanReviews.length, bot: botReviews.length },
    comments: {
      human: comments.filter((c) => !isBot(c)).length,
      bot: comments.filter(isBot).length,
    },
    changesRequested: reviews.some((r) => r.state === "CHANGES_REQUESTED"),
    commitsAfterFirstReview,
    ciFailures: countCiFailures(checks),
    reverted: revertedBy === true,
    state: pull.state,
    mergedAt,
    timeToMergeMinutes,
    collectedAt: now,
    basis: "observed",
  }
}
