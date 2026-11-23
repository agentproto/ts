# @agentproto/tooling

## 0.1.1

### Patch Changes

- 5b792bc: Covers the packages the PR's own changesets (`remove-private-names.md`, `voice-kit-turn-settings.md`) miss. Private product and repository names were scrubbed from comments, docs, changelogs, fixtures and tests in these packages; no runtime behavior changes (changelog/docs/test-only edits, plus the catalog-sync ledger key noted in the review).

## 0.1.0

### Patch Changes

- bb2fd89: Publish to npm. Previously ignored by changesets and marked `private`, so
  consumers outside this monorepo's pnpm workspace (e.g. `@agstudio/footprint`
  in demo-app) could depend on it only via `workspace:*`, which doesn't
  resolve across separate git repos. It is a pure config package (TypeScript
  `tsconfig` bases + a tsup config factory, no runtime code), so publishing it
  carries no runtime surface to maintain.
