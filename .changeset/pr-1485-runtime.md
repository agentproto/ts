---
"@agentproto/runtime": minor
---

Add AIP-58 §6 `run.retry` — the `workflow_retry` MCP tool starts a new run from a `failed`/`cancelled` runId that replays every step the original already completed (no re-execution) and resumes from the first step that never succeeded, using an always-on internal per-run journal (no `cacheKey` opt-in required). A run orphaned by `sweep()` (owner lease expired, §2) is retryable like any other failed run.
