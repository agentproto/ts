---
"@agentproto/agencies": major
"@agentproto/agent-runtime": patch
"@agentproto/catalog": major
"@agentproto/cli": patch
"@agentproto/corpus": major
"@agentproto/eval": major
"@agentproto/governance": minor
"@agentproto/governance-engine": patch
"@agentproto/inference-endpoint": major
"@agentproto/model-routing": major
"@agentproto/quota": minor
"@agentproto/review": minor
"@agentproto/runtime": major
"@agentproto/workspace": minor
---

Adopt the canonical AIP-70 document tags (`runtime/v1`, `workspace.*/v1`, `review.attestation/v1`, `review.pack-digest/v1`, `governance/v1`) as the writer output, remove the pre-AIP-70 aliases (`SPEC_NAME` exports, `definePack`/`Pack`, runtime re-exports, the duplicate `llm-endpoint` bin), and centralize the Anthropic unified rate-limit parser in `@agentproto/quota`. Readers continue to accept the legacy tags. The emit-tag flips are minor because they change schema/alg strings embedded in signed attestations and hashed audit rows; the alias removals are major.
