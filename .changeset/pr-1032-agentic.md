---
"@agentproto/runtime": patch
---

Fix HTTP streaming finalization bug: prevent writing POST-terminal records (like usage_snapshot) after stream is finalized. Add integration test for `/sessions/:id/chat` SSE streaming route validating the complete UI message stream chunk sequence.
