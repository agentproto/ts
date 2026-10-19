# @agentproto/plugin

## 0.2.3

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.

## 0.2.2

### Patch Changes

- c27f0b8: Weekly minor/patch dependency bumps across workspaces (zod, @mastra/*, react, yaml, claude-agent-sdk, etc.).

## 0.2.1

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)

## 0.2.0

### Minor Changes

- 9f584c4: Rename "plugins" to "adapters" in the CLI to free up "plugin" for Agent Plugins v1.0.0 standard. This is a breaking change: `agentproto plugins` → `agentproto adapters`, config key `plugins[]` → `adapters[]`, manifest schema `agentproto/plugin/v1` → `agentproto/adapter/v1`.

  Introduce `@agentproto/pack` (AIP-52 PACK.md reference implementation) and `@agentproto/plugin` (Agent Plugins v1.0.0 reference implementation) packages.
