---
"@agentproto/cli": patch
---

Add @ast-grep/napi native dependency and externalize it from the tsup bundle to prevent platform-specific .node binding resolution conflicts.
