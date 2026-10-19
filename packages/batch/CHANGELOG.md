# @agentproto/batch

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

- 4fb28be: Introduce `@agentproto/batch` — a unified batch-inference contract over provider Batch APIs (Anthropic Message Batches, OpenRouter Batch) plus a local-queue emulation for providers without native batch support. Supports submit, status polling, result collection, and cancellation with a driver-agnostic `BatchDriver` interface; includes durable filesystem store with resumption after crashes.

  Add optional `DistillBatchPort` capability to `@agentproto/corpus` for multi-item distillation in a single call, and implement batch distiller in `@agentproto/corpus-cli` with new `anthropic-batch` and `openrouter-batch` engines for the `corpus distill` command. Both existing `DistillPort` single-item and new batch paths are fully supported and tested.
