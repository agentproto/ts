---
"@agentproto/runtime": minor
---

Remove the dormant `projectBrowserTools` export (and its `browser_kit_*` tool projection). It was never mounted by the daemon and had no consumer; Bureau now owns the browser tool surface (Browser Fabric, AIP-63 S4).
