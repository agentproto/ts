---
"@agentproto/model-catalog": patch
"@agentproto/cli": patch
---

Refresh the Mistral model catalog from the live /v1/models list (adds the
medium tier, codestral, devstral, ministral, magistral; drops retired ids)
and declare a model list on the mistral-vibe generic-ACP spec so its launch
picker offers real models instead of only "custom".
