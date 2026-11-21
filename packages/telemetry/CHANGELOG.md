# @agentproto/telemetry

## 0.2.5

### Patch Changes

- 89258dd: Weekly dependency refresh (minor-patch).

  Held back: `@mastra/code-sdk` stays at 1.14.0 via a root `pnpm.overrides` entry.

  From 1.16.0, `@mastra/code-sdk` declares `@mastra/core` as a peer (`>=1.80.0`)
  instead of an exact dependency, so pnpm binds it to this workspace's deliberately
  pinned `@mastra/core@1.66.0` — a version whose "exports" map does not define the
  `./knowledge` subpath that code-sdk's dist imports, which makes importing
  `@agentproto/adapter-mastracode-inprocess` (and every CLI test that imports it)
  fail with `Package subpath './knowledge' is not defined by "exports"`. 1.14.0 is
  the resolution this lockfile already proved green, so the hold pins it exactly
  rather than float onto an untested 1.15.x. Lift the hold once the
  mastracode-inprocess adapter moves to a `@mastra/core` that exports
  `./knowledge` (>= 1.78.0).

## 0.2.4

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.

## 0.2.3

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)

## 0.2.2

### Patch Changes

- 04aedad: Weekly dependency bump with semver-safe minor/patch updates across 18 packages. Includes Mastra ecosystem update (1.31-1.48.x → 1.52.1), Claude SDK patch (0.3.200 → 0.3.220), build tool updates (turbo, tsx), and general dependency maintenance (yaml, ws, react, etc.). All changes verified to pass build, test, and type checks.

## 0.2.1

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0

## 0.2.0

### Minor Changes

- 559cd7d: Add @agentproto/telemetry port + OTel adapter and @agentproto/eval scorers + runEval
