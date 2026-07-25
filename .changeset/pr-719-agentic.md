---
"@agentproto/cli": patch
"@agentproto/runtime": patch
---

Implement resume-honesty fix (AIP-45 resumable capability): prevent silently presenting blank sessions as continuations. When adapters declare `capabilities.resumable: false` (e.g. hermes, mastra-agent), the restart path now gates all ACP-level resume attempts, substituting honest "fresh — resume not supported by X" labels and emitting `contextRestored: false` event flags. Lazy-revived unresumable sessions now get clear banners to prevent confusion with actual continuity.
