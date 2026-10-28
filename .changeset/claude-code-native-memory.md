---
"@agentproto/harness": minor
"@agentproto/runtime": minor
"@agentproto/adapter-claude-code": minor
"@agentproto/cli": patch
---

AIP-72 section 9 native-dir projection and native-dir-diff capture for claude-code. `@agentproto/harness` adds `native-memory.ts` (`projectNativeMemory`, `diffNativeMemory`, `nativeToMemoryV1`, `nativeMemoryProposals`, `nativeMemoryUnavailable` and the snapshot helpers) and a `memoryProjection` start option: the claude-code driver pins `autoMemoryDirectory: <configDir>/memory` in the isolated `settings.json`, writes one `agentproto_<slug>.md` topic file per in-force item plus a bounded fenced block at the top of `MEMORY.md`, and persists a `{file: sha}` snapshot in the config dir. When auto memory is off (`CLAUDE_CODE_DISABLE_AUTO_MEMORY`, a repo `autoMemoryEnabled: false`) or the repo pins its own `autoMemoryDirectory`, it projects nothing and appends the digest to the system prompt instead. `@agentproto/runtime` routes a `native-dir` adapter's digest selection into that option and, at each turn end and session exit, diffs the dir and writes new or changed native files to the agent's store as proposals, never commits, once per content. `@agentproto/adapter-claude-code` declares `capabilities.memory { inject: "native-dir", capture: "native-dir-diff" }`. `@agentproto/cli` forwards the projection and the adapter's `capabilities.memory.capture`.
