---
"@agentproto/catalog-sync": patch
---

Test-only: stop pinning exact OpenCode route/model counts in the `llm:opencode-*` generator tests in favor of bounded assertions, so catalog-regeneration drift no longer reddens CI.
