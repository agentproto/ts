---
"@agentproto/runtime": patch
---

A restarted session keeps its predecessor's display name. `restartAgentSession` copied `label` but not the derived `title` or the `renamedByUser` flag, so the successor re-derived its title from the resume prompt and that title outranked the carried label. New `registry.inheritDisplayName` carries both across.
