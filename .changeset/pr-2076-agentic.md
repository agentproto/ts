---
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

fix(sentinel): auto-link PRs opened by sandboxed sessions and target the live successor

A sandboxed session's cwd is a path inside its box, so the PR reconciler's branch lookup found no host checkout and every `gh` call ran in a non-existent directory — the PR was never recorded and no sentinel was created. Sandboxed sessions now resolve their PR from the box work branch (`sandboxDeliveryTarget.branch`) against the workspace's host checkout, and `gh` runs from there; `OpenPrResolver` accepts an optional `{ branch }` override. Auto-link also follows the `continuedTo` chain so a PR recorded on a row that a restart/continue superseded is watched for the live successor, without creating a duplicate sentinel.
