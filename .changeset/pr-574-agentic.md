---
"@agentproto/runtime": minor
---

Add `listImportCandidates` for universal conversation import across multiple harnesses. The new function discovers external conversations (claude-code, hermes) that can be reattached as live sessions, replacing claude-code-only logic with a store-agnostic abstraction. Generalizes over `ConversationStore.attachArgv` — any harness with native reattach capability can now be discovered and reattached.
