---
"@agentproto/agencies": major
"@agentproto/catalog": major
"@agentproto/cli": patch
"@agentproto/corpus": major
"@agentproto/eval": major
"@agentproto/inference-endpoint": major
"@agentproto/model-routing": major
"@agentproto/quota": minor
"@agentproto/runtime": major
---

Remove the pre-AIP-70 aliases (`SPEC_NAME` exports, `definePack`/`Pack`, runtime re-exports, the duplicate `llm-endpoint` bin) and centralize the Anthropic unified rate-limit parser in `@agentproto/quota`. The CLI `review verify` path and the runtime review ledger and compose paths now treat `agentproto-pack-digest/v1` and `review.pack-digest/v1` as the same digest recipe, so attestations written with either tag compare correctly.
