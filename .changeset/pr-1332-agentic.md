---
"@agentproto/adapter-claude-code": patch
"@agentproto/adapter-claude-sdk": patch
---

Relax curated-models / gateway-modes test assertions for `opencode-go` from exact literal id lists to membership checks, keeping the derived-menu equality assertions as the exact-shape guard (de-flakes catalog syncs).
