---
"@agentproto/acp": minor
"@agentproto/harness": minor
"@agentproto/runtime": minor
---

Retry transient model re-assert on resume and enforce profile allow-lists.

- `@agentproto/acp`: add optional `AcpClientOptions.modelApplyRetry` to bound the re-assert retry after a connect-time model-apply failure, retrying only transient (429/rate-limit) rejections.
- `@agentproto/harness`: expose `AgentCliRuntimeSession.modelApplyRejection` so hosts can see a rejected model apply instead of assuming the requested model.
- `@agentproto/runtime`: fold per-profile model curation into spawn eligibility (ordered `profileRefs` fall through to the next model-eligible profile), share one canonical identity rule between the catalog read path and the spawn/live `set_model` write paths, and stop the descriptor from claiming a rejected/unknown model.
