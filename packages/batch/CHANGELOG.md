# @agentproto/batch

## 0.2.0

### Minor Changes

- 4fb28be: Introduce `@agentproto/batch` — a unified batch-inference contract over provider Batch APIs (Anthropic Message Batches, OpenRouter Batch) plus a local-queue emulation for providers without native batch support. Supports submit, status polling, result collection, and cancellation with a driver-agnostic `BatchDriver` interface; includes durable filesystem store with resumption after crashes.

  Add optional `DistillBatchPort` capability to `@agentproto/corpus` for multi-item distillation in a single call, and implement batch distiller in `@agentproto/corpus-cli` with new `anthropic-batch` and `openrouter-batch` engines for the `corpus distill` command. Both existing `DistillPort` single-item and new batch paths are fully supported and tested.
