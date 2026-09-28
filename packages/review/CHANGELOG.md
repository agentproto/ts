# @agentproto/review

## 0.3.0

### Minor Changes

- de2decc: Review attestation signing and composition: `@agentproto/review` gains `canonicalJson`, `canonicalAttestationBytes`, and `attestationSha256` plus optional `Attestor.signature` and `LaneResult.composedFrom` fields. `@agentproto/runtime` adds `review-signing.ts` (SSH-keygen-based `signAttestation`/`verifySignedAttestation`, key management, `ReviewConfig`) and `review-compose.ts` (delta re-review composition). `@agentproto/cli` adds the `review key` subcommand and `verify --allowed-signers/--require-signed` (exit code 6). The review panel shows signed/unsigned badges.

### Patch Changes

- c6e3989: Pack rubric paths are now confined to the pack's own root in the runtime loader: `PackSource.readRubric` realpaths both the resolved path and the pack root and refuses to read anything that resolves outside it — covering `../../` escapes, absolute paths, and same-directory symlinks pointing elsewhere — regardless of whether the pack is trusted. `resolvePacks` now eagerly reads every selected agent check's rubric at resolve time and wraps any loader failure in a `ReviewManifestError` naming the pack and check, so a violating pack fails the review up front instead of mid-session.

## 0.2.0

### Minor Changes

- 8fe9f81: Add @agentproto/review primitive + review_* daemon tools (run/status/cancel/ledger/export)
- a519173: Review primitive CLI and provenance: new `agentproto review run|verify|init` verb (daemon-backed or headless runs, attestation verification, REVIEW.md + pre-push hook + Actions scaffold); attestations gain optional `requester` and `pr` provenance and agent lanes record the reviewer's model; the runner gains `supersede` and head-aware dedupe; the ledger gains a mutable PR annotations sidecar with a new `review_pr` MCP tool that links attestations to GitHub PRs via `gh` and snapshots PR status.

### Patch Changes

- Updated dependencies [6c68009]
- Updated dependencies [9a5d311]
- Updated dependencies [502f4c9]
  - @agentproto/workflow@0.7.0
