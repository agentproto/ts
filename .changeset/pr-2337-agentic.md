---
"@agentproto/runtime": minor
"@agentproto/agent": patch
"@agentproto/cli": patch
"@agentproto/memory": patch
---

AIP-72 daemon memory surface. `@agentproto/runtime` serves the memory store as seven `memory_*` MCP tools with a propose/commit write policy (commit, supersede, archive and dismiss require the operator or a `supervisor` session, read from `meta.role` on both the sync and async-worktree descriptors; `memory.enabled: false` sessions write nothing), resolves a per-agent `memory.store` for both the spawn digest and the tools, adds the `memory.root` config key, and appends a bounded AIP-72 section 9 digest to the system prompt at spawn. `@agentproto/agent` types the AIP-42 `memory` block's AIP-72 fields (`enabled`, `store`, `anchors`). `@agentproto/cli` forwards the adapter's `capabilities.memory.inject` to the runtime. `@agentproto/memory` documents the daemon tools and digest in its README.
