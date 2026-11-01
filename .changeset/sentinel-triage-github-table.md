---
"@agentproto/sentinel": patch
---

Make GitHub triage rules explicit as a table of event class to delivery, add tests for every row, and keep the existing coalesced repeat rule after the table.

The table is intentionally checked before the generic rules, so it overrides them for the GitHub event classes it covers:

- a terminal `github.pull_request.closed` (merged or not) is now `fyi` instead of `wake`;
- failing checks, failing workflow runs, `changes_requested` reviews and `action_required` now record `rule: "github-triage-table"` instead of `"failure"`;
- a first `success`/`neutral`/`skipped` check or workflow run, and every `github.pull_request.synchronize`, is now `fyi` instead of the previous `default` wake.

Triage remains observation-only (`applied: false`), so delivery is unchanged.
