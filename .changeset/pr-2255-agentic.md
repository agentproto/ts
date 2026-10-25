---
"@agentproto/sentinel": minor
"@agentproto/runtime": patch
---

Extract the AIP-60 sentinel primitive into the new `@agentproto/sentinel` package (store, runtime, providers, MCP tools, webhook outbox). `@agentproto/runtime` now depends on the package through a runtime-owned platform-port layer and re-exports the same public names, so its API is unchanged.
