---
"@agentproto/apps": minor
"@agentproto/worktree": minor
"@agentproto/runtime": patch
---

repo-maintenance `maintain`: every `salvage` verdict now ends in an explicit next action instead of waiting forever. The report gets a "Salvage follow-up" section (and the run output a `salvage` list): `pr-candidate` for a verdict at most `salvageStaleDays` (default 14) days old, with the reviewer's proposed PR title (new optional `triage.prTitle` on `branch_gc_verdict`, else `triage.salvage`, else the tip subject) and whether the tip merges cleanly into base (`git merge-tree --write-tree`), `stale-salvage` for an older one. A salvage tip is re-reviewed once when base gained more than `salvageRereviewMoved` (default 100) commits since the verdict (new `verdict.baseMoved` on branch_gc plan entries), since verdicts are keyed by sha only. Report only: no PR is opened and nothing is deleted.
