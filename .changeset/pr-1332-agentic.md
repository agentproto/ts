---
"@agentproto/adapter-claude-code": patch
"@agentproto/adapter-claude-sdk": patch
"@agentproto/adapter-opencode": patch
---

Relax curated-models / gateway-modes / endpoint-menu test assertions from exact literal id lists and pinned counts to membership and bounds checks, keeping the catalog-derived equality assertions as the exact-shape guard (de-flakes weekly catalog syncs, cf. #1324/#1328/#1309/#1331).
