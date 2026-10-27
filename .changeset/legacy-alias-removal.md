---
"@agentproto/agencies": major
"@agentproto/catalog": major
"@agentproto/corpus": major
"@agentproto/eval": major
"@agentproto/inference-endpoint": major
"@agentproto/model-routing": major
"@agentproto/runtime": major
---

Remove the pre-AIP-70 leftovers: deprecated `SPEC_NAME` exports, the `definePack`/`Pack` model-routing aliases, the runtime re-exports of symbols owned by extracted packages, and the `inference-endpoint` compatibility bin. Import those symbols from their owning packages and use `defineRoutingPack`/`RoutingPack` for model-routing packs.
