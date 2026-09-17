---
"@agentproto/adapter-claude-code": patch
---

Relax the curated-models test's `opencode-go` assertion from an exact literal list to membership checks, keeping the derived-menu equality assertions as the exact-shape guard (de-flakes catalog syncs).
