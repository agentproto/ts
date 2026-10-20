---
"@agentproto/runtime": minor
"agentproto-vscode": patch
---

Restore wallet (auth-profile) choice in the VS Code launch and change-wallet pickers after the catalog went compact. The runtime's `catalog_models` COMPACT rows now carry the cheap presence ids — `eligibleProfiles`, `adapters`, `adapterModes` — so a client paging COMPACT rows can resolve "which wallet can bill this route" without a `full: true` round trip that overruns the MCP result cap and truncates to a stub the client misreads as an empty catalog. `agentproto-vscode`'s `DaemonClient.catalogModels()` now pages that tool with `limit`/`cursor` (falling back to one unpaged full call on pre-pagination daemons) instead of asking for the whole full catalog in a single result — the truncated full response used to leave the spawn wizard on the manifest fallback (no route, so only the daemon's default wallet ever attached) and the change-wallet access chip offering only "Add a new wallet".
