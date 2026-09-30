# @agentproto/pair-client

## 0.2.3

### Patch Changes

- Updated dependencies [a68d1d6]
  - @agentproto/secrets@1.2.0
  - @agentproto/acp@0.9.1

## 0.2.2

### Patch Changes

- 461df5e: Package-metadata refresh accompanying the vendored-specs resync (PR #1554): homepage URLs and keyword tags renumbered to the ratified AIP numbers (app-kit/apps → AIP-53, mastra → AIP-52, define-doctype → AIP-56, wallet → AIP-49), a stale agentik.net homepage corrected (redaction), new keyword tags (pair-client → AIP-59, runtime → AIP-46/AIP-58), and test/doc-comment updates replacing the retired sandbox AIP-61 placeholder with a 9999 fixture number (product, ref), plus bundled SKILL.md renumbering (skill-pack-agentproto) and a routine doc comment aligned with the now-upstream `targetAgent` variant. No runtime behavior changes.
  - @agentproto/acp@0.9.1
  - @agentproto/secrets@1.1.1

## 0.2.1

### Patch Changes

- Updated dependencies [332aebf]
  - @agentproto/secrets@1.1.0
  - @agentproto/acp@0.9.0

## 0.2.0

### Minor Changes

- 5f0f9d1: Add web-fragment pair offers, browser pair-client tunnel, and pairing revocation signalling
- ef9f57e: Widen the daemon identity fingerprint from 64 to 128 bits and default `pairing.pairPage` to the new per-daemon `{fingerprint}.agentproto.cloud` pair page (`DEFAULT_PAIR_PAGE`); offer URLs now require the 32-hex fingerprint id.

### Patch Changes

- Updated dependencies [65777ee]
- Updated dependencies [8c74864]
- Updated dependencies [dc87d79]
- Updated dependencies [7d825ff]
- Updated dependencies [535779b]
- Updated dependencies [476b1ca]
- Updated dependencies [f70d919]
- Updated dependencies [5f0f9d1]
- Updated dependencies [ef9f57e]
  - @agentproto/acp@0.9.0
  - @agentproto/secrets@1.0.0
