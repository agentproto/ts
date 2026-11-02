---
"@agentproto/worktree": minor
"@agentproto/runtime": minor
"@agentproto/cli": minor
"@agentproto/apps": minor
---

branch gc: a deterministic `verified-pr` pass lets a reviewed branch past the line-coverage guard when a `superseded` verdict cites a PR (new optional `landedIn`, else `#N` in the gate) that the forge confirms merged into base, and every file with uncovered lines was touched by that PR, is a consumed `.changeset/*.md`, or is a path base deleted or moved after that PR merged. On by default; `requireOperatorBelowGuard` / `--require-operator-below-guard` turns it off. The outcome and restore log carry `guard: "verified-pr"` with the proof, refusals carry `verifiedPrRefusal`, and the maintain report lists auto-passed tips apart from the human decision queue. New `agentproto branch gc restore <restore-log>` (and the `branch_gc_restore` MCP tool) re-creates deleted refs from a restore log (commands rebuilt from validated fields, the log's repo must be the caller's), refuses to overwrite a ref at another sha, and drops the restored tips' operator approval so the next run re-judges them.
