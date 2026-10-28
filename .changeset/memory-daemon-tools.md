---
"@agentproto/runtime": minor
"@agentproto/cli": patch
"@agentproto/agent": patch
---

The daemon serves the AIP-72 memory store as MCP tools: `memory_search`, `memory_list`, `memory_read`, `memory_write` (default mode `propose`), `memory_supersede`, `memory_archive` and `memory_dismiss`. Anyone proposes; a commit, supersede, archive or dismiss needs the operator or a session spawned with the `supervisor` role, read from the role now recorded on every session's descriptor (`meta.role`); a session whose agent sets AIP-42 `memory.enabled: false` writes nothing. The default store lives at `~/.agentproto/memory` (new config key `memory.root`), and an agent's AIP-42 `memory.store` wins when it names a files root. An agent whose AGENT.md binds memory (`memory.enabled: true`, `store` or `anchors`) gets the AIP-72 section 9 digest of its in-force, in-scope items appended to its system prompt at spawn, bounded with an "items left out" line; an adapter declaring `capabilities.memory.inject: native-dir` gets none through this path. `@agentproto/cli` forwards the adapter's `capabilities.memory.inject` to the runtime. `@agentproto/agent` types the AIP-42 `memory` block's AIP-72 fields (`enabled`, `store`, `anchors`) on `MemoryConfig`.
