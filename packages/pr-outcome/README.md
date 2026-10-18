# pr-outcome

After a PR merges, `collect()` walks its merged pulls via an injected `GhFetcher` (a thin `gh` CLI wrapper using argument arrays), parses the `@agentproto-bot` provenance footer back into structured data, and joins it with reviews, comments, fix-commits-after-first-review, CI failures, and revert detection to make one `pr-outcome` record per PR.

**These statistics are ANECDOTAL — illustration only. They are never an input to routing rules**, quotas, or any automated decision. Every record has `basis: "observed"`; fields that were not observable are left `undefined`, never invented.

Run: `pnpm --filter @agentproto/pr-outcome test`.

## Usage

```ts
import { collect, GhCliFetcher } from "@agentproto/pr-outcome"
const { outcomes, skipped } = await collect(new GhCliFetcher(), "owner/repo", { limit: 50 })
```

Needs an authenticated `gh` CLI. `GhCliFetcher` uses `gh api --paginate --slurp` (gh >= 2.50). It reads the whole closed-PR listing before `limit` applies, so use a small repo or a custom `GhFetcher` for very large histories.

## Notes

- Footer parsing mirrors `buildFooter` in `@agentproto/runtime/pr-provenance` (the marker is imported from there; tests build real footers with it). Token counts of 1000+ are rendered as `12.3k`, so they parse back rounded to the nearest hundred (12345 -> 12300).
- Revert detection: a PR merged later whose title is `Revert "<title>"`, or whose body says `This reverts commit <sha>` for this PR's merge commit.
- Comments count both PR conversation comments and inline review comments.
