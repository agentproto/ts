---
"@agentproto/apps": patch
"@agentproto/cli": patch
"@agentproto/runtime": minor
"@agentproto/worktree": minor
---

Make branch gc output something an operator can act on.

- `summarizeBranchGcPlan` adds `summary.distinct`: branch counts keyed by name across ref kinds (a local branch and its remote twin count once), next to the per-kind ref counts. `agentproto branch gc` prints it.
- The `branch_gc` MCP reply is compact by default: the summary, the plan metadata and one page of entries (name, kind, sha, class, status, reclaimReason / mergedPr / mergedPrMatch / holdReason / lineCoverage.pct / verdictGuard when set), 100 rows per page. `cursor` pages the same run without re-running it. `classes`, `fields` and `limit` shape the page, and `full: true` returns today's whole result. An apply still returns every outcome and the restore log. Callers that read full plan entries must now pass `full: true`.
- The repo-maintenance `maintain` workflow requests `full: true` on each branch_gc call, headlines "N branches (M refs)", lists the whole human decision queue (lowest line coverage first) with the `branch_gc_verdict` operator-approval call that clears an entry, and names where the full list is for every other capped list (`review` and `verdictRecords` are now in the run output).
