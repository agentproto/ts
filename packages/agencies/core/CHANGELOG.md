# @agentproto/agencies

## 1.0.0

### Major Changes

- e301b84: Remove the pre-AIP-70 leftovers: deprecated `SPEC_NAME` exports, the `definePack`/`Pack` model-routing aliases, the runtime re-exports of symbols owned by extracted packages, and the `inference-endpoint` compatibility bin. Import those symbols from their owning packages and use `defineRoutingPack`/`RoutingPack` for model-routing packs.
- e301b84: Remove the pre-AIP-70 aliases (`SPEC_NAME` exports, `definePack`/`Pack`, runtime re-exports, the duplicate `llm-endpoint` bin) and centralize the Anthropic unified rate-limit parser in `@agentproto/quota`. The CLI `review verify` path and the runtime review ledger and compose paths now treat `agentproto-pack-digest/v1` and `review.pack-digest/v1` as the same digest recipe, so attestations written with either tag compare correctly.

### Patch Changes

- Updated dependencies [e301b84]
  - @agentproto/governance@1.0.0

## 0.2.0

### Minor Changes

- 16d10ed: Add an internal data-format id (`AGENCIES_FORMAT`, `AGENT_CLI_FORMAT`), so the packages no longer present their format ids as AIP registry spec names. The legacy `SPEC_NAME` export is retained for compatibility and is now deprecated; it remains a legitimate pending registry-name deviation until it is removed.

### Patch Changes

- Updated dependencies [6b78431]
- Updated dependencies [9fbf379]
- Updated dependencies [5ab8114]
- Updated dependencies [5ab8114]
  - @agentproto/governance@0.2.0

## 0.1.6

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [74f982c]
- Updated dependencies [74f982c]
  - @agentproto/governance@0.1.6

## 0.1.5

### Patch Changes

- @agentproto/governance@0.1.5

## 0.1.4

### Patch Changes

- c27f0b8: Weekly minor/patch dependency bumps across workspaces (zod, @mastra/*, react, yaml, claude-agent-sdk, etc.).
- Updated dependencies [c27f0b8]
  - @agentproto/governance@0.1.4

## 0.1.3

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
  - @agentproto/governance@0.1.3

## 0.1.2

### Patch Changes

- f0c51a7: Weekly dependency bump: update 9 minor/patch dependencies to latest versions.
  - @anthropic-ai/claude-agent-sdk 0.3.241 → 0.3.251
  - @ast-grep/napi 0.45.2 → 0.45.3
  - @earendil-works/pi-tui 0.84.2 → 0.84.4
  - @tanstack/react-query 5.102.2 → 5.102.8
  - @testing-library/react 16.3.2 → 16.3.3
  - e2b 2.45.0 → 2.46.1
  - tsx 4.23.12 → 4.23.13
  - turbo 2.10.11 → 2.10.12
  - zod 4.4.3 → 4.5.4

  No code changes; pnpm-lock.yaml updated to reflect new dependency versions.

- Updated dependencies [f0c51a7]
  - @agentproto/governance@0.1.2

## 0.1.1

### Patch Changes

- 04aedad: Weekly dependency bump with semver-safe minor/patch updates across 18 packages. Includes Mastra ecosystem update (1.31-1.48.x → 1.52.1), Claude SDK patch (0.3.200 → 0.3.220), build tool updates (turbo, tsx), and general dependency maintenance (yaml, ws, react, etc.). All changes verified to pass build, test, and type checks.
- Updated dependencies [04aedad]
  - @agentproto/governance@0.1.1

## 0.1.0

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
  - @agentproto/governance@0.1.0
