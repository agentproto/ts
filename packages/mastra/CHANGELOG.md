# @agentproto/mastra

## 0.3.0

### Minor Changes

- 97a0074: Rename three packages to their AIP-70 names: `@agentproto/llm-endpoint` to `@agentproto/inference-endpoint` (AIP-61), `@agentproto/app-kit` to `@agentproto/app` (AIP-53) and `@agentproto/mastra` to `@agentproto/bridge` (AIP-52). The old names stay as deprecated re-export shims with the same exports, and every workspace dependency, import, test and doc points at the new names.
- 97a0074: Complete the AIP-52/AIP-53/AIP-61 batch renames: add the canonical `@agentproto/bridge`, `@agentproto/app` and `@agentproto/inference-endpoint` packages (moved from `mastra`, `app-kit` and `llm-endpoint`), keep the old names as deprecated re-export shims, and repoint every workspace dependency, import, test and doc at the new names.

  This complements the changeset already in the PR (`.changeset/aip70-p3-batch7b-renames.md`); the two are merged by changesets so each package is bumped at most once.

### Patch Changes

- Updated dependencies [97a0074]
- Updated dependencies [c6e0daa]
- Updated dependencies [97a0074]
- Updated dependencies [c6e0daa]
  - @agentproto/bridge@0.3.0
