---
"@agentproto/runtime": minor
---

The prompt-cache split (`cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`) now survives the durable usage path. `usage_rollup` buckets sum it as a window delta, a sandboxed session's usage read-back forwards it from the box's `session_usage` answer (new exported `projectRemoteUsage`), and the direct-child rows of `session_usage` with `includeSubtree` carry their own split, with `reasoningTokens` rolled into the subtree totals. A field that no session reports stays absent and never reads as a measured 0.
