---
"@agentproto/apps": patch
---

Regenerate the stale work-board `panel.generated.ts` bundle so the committed artifact matches the post-#1303 panel-bridge sources (standalone connect behavior, display-mode/pin toggles). Also hardens the auto-merge workflow to skip arming while a PR is behind its base, closing the stale-merge race from #1302/#1303.
