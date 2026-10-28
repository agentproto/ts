---
"@agentproto/harness": minor
"@agentproto/runtime": minor
"@agentproto/adapter-claude-code": minor
"@agentproto/cli": patch
"@agentproto/memory": patch
---

AIP-72 section 9 native-dir projection and native-dir-diff capture for claude-code. `@agentproto/harness` adds `native-memory.ts` (project/normalize/diff/snapshot helpers) and a `memoryProjection` start option that pins `autoMemoryDirectory` inside the session config dir, writes one `agentproto_<slug>.md` per in-force item plus a bounded `MEMORY.md` index block, and falls back to the system-prompt digest when auto memory is off or the repo pins its own dir. `@agentproto/runtime` routes a `native-dir` adapter's selection into that option, splits `selectMemoryItems`/`renderMemoryDigest` out of the digest builder, and diffs the projected dir at turn end and exit to write new or changed native files as proposals (never commits, once per content). `@agentproto/adapter-claude-code` declares `capabilities.memory { inject: "native-dir", capture: "native-dir-diff" }`. `@agentproto/cli` forwards the projection and the adapter's capture capability. `@agentproto/memory` documents the native memory behavior.
