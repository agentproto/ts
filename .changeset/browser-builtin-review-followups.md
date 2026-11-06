---
"@agentproto/runtime": patch
---

A config that sets only `defaults.browser.proxyImport` keeps its old `on` behaviour (`proxy` is opt-in through `builtin: "proxy"`). In proxy mode, `browser_status` answers `browser:use_bureau` naming `browser_list_instances`, and proxy mode with no imported-MCP registry fails with an explicit error.
