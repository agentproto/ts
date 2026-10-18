---
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

fix(sentinel): auto-link PRs opened by sandboxed sessions, and keep the sentinel on the live session across restart

The PR reconciler (which records a session's opened PR and so triggers sentinel auto-link) used the session's cwd to find the PR, but a sandboxed session's cwd is a path inside its box. The branch lookup found nothing, and every `gh` call ran in a directory that does not exist on the host, so the PR was never recorded and no sentinel was created. A sandboxed session's PR is now resolved from its box work branch (`sandboxDeliveryTarget.branch`), checked against the host checkout of its workspace, and `gh` runs from there. `OpenPrResolver` takes an optional `{ branch }` override for this.

Auto-link now also targets the end of the session's `continuedTo` chain. A PR recorded on a row that a restart or continue already superseded (for example a sandboxed session moved to a fresh box under a new id) is watched for the live successor, and the successor re-recording the same PR does not create a second sentinel.
