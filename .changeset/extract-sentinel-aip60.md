---
"@agentproto/sentinel": minor
"@agentproto/runtime": patch
---

Extract the AIP-60 sentinel primitive into the new `@agentproto/sentinel` package. The sentinel store, runtime, providers, MCP tools and webhook outbox now live there; `@agentproto/runtime` depends on the package and re-exports the same public names.
