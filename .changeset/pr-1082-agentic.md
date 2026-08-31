---
"@agentproto/catalog-sync": patch
---

Fixes to context-windows generator: test assertion changed to floor (preventing automation failures on normal sync drift), and derived bare Anthropic model IDs from dated siblings (same fix pattern as pricing generator, addresses regression from pricing refactoring).
