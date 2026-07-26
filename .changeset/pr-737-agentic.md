---
"@agentproto/runtime": patch
---

Fix telegram inbound source to use channel name instead of chat ID, preventing binding lookup failures. Also skip disk read when persist is disabled to avoid test isolation issues.
