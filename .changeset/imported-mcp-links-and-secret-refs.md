---
"@agentproto/runtime": patch
"@agentproto/plugin-local-browser": patch
"@agentproto/cli": patch
---

Imported MCPs link to their source and keep secrets out of `imported-mcps.json` (P1). Entries gain additive optional fields (`origin`, `resolve: "live" | "snapshot"`, `secretRefs`); the file stays `version: 1`. `resolveImportConnection` resolves `live` entries against discovery (exact id, else same source+scope url/command+args match; missing source falls back to the snapshot and reports `stale`) and resolves `secretRefs` from the keychain into the same header/env key. On import (`mcp_import`, `POST /mcps/imports`) literal header/env values are stored via `storeMcpSecret` and replaced by refs (literal + warning when no store). `McpProxyRegistry` reconnects when a live source file's mtime changes; `stale`/`resolve`/secret key names surface in `mcp_imported_status`, `capabilities_inventory` and `/mcps/proxy/status`. New `agentproto mcp migrate-secrets [--apply]` (dry-run default) migrates existing entries. Settings bundles export secret key names only and report dangling secrets on apply.
