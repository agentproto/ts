---
"@agentproto/ref": minor
"@agentproto/product": minor
---

Consolidate @agentproto/ref-catalog into @agentproto/ref; add URI parsing for product.on. The ref package now exports both schemes: canonical aip:// ArtifactRef/RefCatalog surface (AIP-54, SPEC_NAME ref/v1) and superseded agentref/v1 world scheme (AIP-27). Product defineProduct accepts aip:// URI form for 'on' (normalized to ArtifactRef, loud error on malformed); collectPriced now reports dangling refs via {resolved, dangling} instead of dropping them silently.
