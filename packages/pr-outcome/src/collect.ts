import type { GhFetcher } from "./gh-fetcher.js"
import { parseFooter } from "./parse-footer.js"
import { computeOutcome } from "./outcome.js"
import { isRevertOf } from "./revert.js"
import type { GhPull, PrOutcome, SkippedOutcome } from "./types.js"

/**
 * Collect PR outcomes for a repo through an injected GhFetcher. Records are
 * anecdotal observations, never routing inputs. A PR whose fetch throws is
 * reported in `skipped` and the rest continue.
 */
export interface CollectOpts {
  /** Inspect only the first N merged PRs the fetcher returns. */
  limit?: number
  now?: string
}

export interface CollectResult {
  outcomes: PrOutcome[]
  skipped: SkippedOutcome[]
}

export async function collect(
  fetcher: GhFetcher,
  repo: string,
  opts: CollectOpts = {},
): Promise<CollectResult> {
  const outcomes: PrOutcome[] = []
  const skipped: SkippedOutcome[] = []

  let all: GhPull[]
  try {
    all = await fetcher.listMergedPulls(repo)
  } catch (err) {
    skipped.push({ repo, reason: `listMergedPulls failed: ${(err as Error).message}` })
    return { outcomes, skipped }
  }
  const pulls = typeof opts.limit === "number" ? all.slice(0, opts.limit) : all

  for (const pull of pulls) {
    try {
      const [reviews, comments, commits, checks] = await Promise.all([
        fetcher.listReviews(repo, pull.number),
        fetcher.listComments(repo, pull.number),
        fetcher.listCommits(repo, pull.number),
        fetcher.listChecks(repo, pull),
      ])
      const laterPulls = all.filter(
        (p) => p.number !== pull.number && !!p.mergedAt && !!pull.mergedAt && p.mergedAt > pull.mergedAt,
      )
      const outcome = computeOutcome(
        { repo, pull, reviews, comments, commits, checks, revertedBy: isRevertOf(pull, laterPulls) },
        opts.now,
      )
      const provenance = parseFooter(pull.body ?? "")
      if (provenance) outcome.provenance = provenance
      outcomes.push(outcome)
    } catch (err) {
      skipped.push({ repo, number: pull.number, reason: (err as Error).message })
    }
  }
  return { outcomes, skipped }
}
