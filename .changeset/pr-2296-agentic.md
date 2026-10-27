---
"@agentproto/runtime": patch
---

Classify a Codex usage cap printed as assistant text as provider-limit, so a bare "Internal error" that follows the cap message is attributed to the provider quota rather than a generic turn failure.
