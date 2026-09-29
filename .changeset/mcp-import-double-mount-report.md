---
"@agentproto/runtime": patch
---

`capabilities_inventory.mcp.imported[].alsoNativeIn` (P3, report only): lists other discovered harness-config entries (`{ source, scope, name, sameName }`) that point at the same upstream as an import (url: query/trailing slash stripped, `localhost` = `127.0.0.1`; stdio: command basename + non-absolute args), so a double mount is visible. Identity fields only. Limitation: only host configs and registered workspaces are scanned. Nothing is rewritten.
