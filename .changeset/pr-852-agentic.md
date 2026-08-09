---
"@agentproto/runtime": patch
"agentproto-vscode": patch
---

Persist permission resolution in the durable transcript so the conversation UI can display resolved permissions and clear the "Awaiting your decision" state. Permission-resolved events are keyed by toolCallId to correlate with their originating agent-prompt asks.
