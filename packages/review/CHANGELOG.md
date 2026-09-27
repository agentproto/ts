# @agentproto/review

## 0.2.0

### Minor Changes

- 8fe9f81: Add @agentproto/review primitive + review_* daemon tools (run/status/cancel/ledger/export)
- a519173: Review primitive CLI and provenance: new `agentproto review run|verify|init` verb (daemon-backed or headless runs, attestation verification, REVIEW.md + pre-push hook + Actions scaffold); attestations gain optional `requester` and `pr` provenance and agent lanes record the reviewer's model; the runner gains `supersede` and head-aware dedupe; the ledger gains a mutable PR annotations sidecar with a new `review_pr` MCP tool that links attestations to GitHub PRs via `gh` and snapshots PR status.

### Patch Changes

- Updated dependencies [6c68009]
- Updated dependencies [9a5d311]
- Updated dependencies [502f4c9]
  - @agentproto/workflow@0.7.0
