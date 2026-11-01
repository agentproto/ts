---
"@agentproto/runtime": patch
---

Keep the `gh` provenance shim's footer when an agent rewrites a PR body: `gh pr edit --body/-b/--body-file/-F` and `gh api -X PATCH .../(pulls|issues)/N` now re-append the existing rendered footer if the new body dropped it, so a rewritten description no longer fails the provenance/hygiene check on the next push.
