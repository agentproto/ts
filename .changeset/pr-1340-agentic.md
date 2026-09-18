---
"@agentproto/runtime": patch
---

Accept a valid per-boot app embed token (`?et=`) as an allowlisted Origin equivalent on the browser-facing gates (`guardBrowserOrigin`, `authorizeMcp`, `checkSessionsToken`), so MCP-Apps widget blob: documents with opaque `Origin: null` can reach the daemon.
