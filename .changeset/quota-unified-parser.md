---
"@agentproto/cli": patch
"@agentproto/quota": minor
---

Move the Anthropic unified rate-limit header parser into `@agentproto/quota` and have the runtime remaining-quota reader use it. The CLI now imports the sentinel view type from `@agentproto/sentinel` instead of the runtime re-export.
