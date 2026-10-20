---
"@agentproto/runtime": patch
"agentproto-vscode": patch
---

Keep the VS Code harness surfaces under the daemon's MCP result cap after the `adapter_list` compact change. `agentproto-vscode`'s `DaemonClient.listAdapters()` now pages the COMPACT rows (no `full`) and exposes `getAdapter(slug)` / `listAdapterModels(slug)` for one adapter's detail; the harnesses tree, auth/model map, auth explorer, Configuration Lab, spawn wizard, change-model and session-config pickers load detail per adapter only when they need it. The runtime adds an `adapter` filter to `adapter_list` and a pageable `adapter_models` tool so even a runaway model list (opencode is ~700 ids) can be fetched one page at a time.
