---
"@agentproto/review": minor
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Review primitive CLI and provenance: new `agentproto review run|verify|init` verb (daemon-backed or headless runs, attestation verification, REVIEW.md + pre-push hook + Actions scaffold); attestations gain optional `requester` and `pr` provenance and agent lanes record the reviewer's model; the runner gains `supersede` and head-aware dedupe; the ledger gains a mutable PR annotations sidecar with a new `review_pr` MCP tool that links attestations to GitHub PRs via `gh` and snapshots PR status.
