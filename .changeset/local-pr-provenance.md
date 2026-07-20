---
"@agentproto/worktree": patch
---

Enrich `SessionRef` with optional `adapterSlug`, `model`, `authMode`, `costUsd`, `tokensIn`, and `tokensOut` echoes from `SessionDescriptor`. These fields are ignored by GC logic and are surfaced in local PR provenance footers.
