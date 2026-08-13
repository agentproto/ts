---
"@agentproto/cli": patch
---

Increase test timeout for all-adapters harness-capabilities test from vitest's 5s default to 30s. The test imports all installed adapters including heavy @mastra/core graph modules on a cold worker, causing it to exceed the default timeout under parallel test runs on loaded machines.
