---
"@agentproto/runtime": minor
"@agentproto/plugin-local-browser": patch
"@agentproto/cli": minor
---

Imported MCPs link to their source and keep secrets out of `imported-mcps.json` (P1). Entries gain additive optional fields (`origin`, `resolve: "live" | "snapshot"`, `secretRefs`); the file stays `version: 1`. A single `resolveImportConnection` chokepoint (shared by the proxy and the MCP-Apps host) resolves `live` entries against discovery (exact id, else same source+scope url/command+args match; missing source falls back to the snapshot and reports `stale`) and resolves `secretRefs` from the OS keychain into the same header/env key, dropping rather than leaking bound secrets when a live source re-points to a different upstream. On import (`mcp_import`, `POST /mcps/imports`) literal header/env values are stored via `storeMcpSecret` and replaced by refs (literal + warning when no store). `McpProxyRegistry` reconnects when a live source file's mtime changes; `stale`/`resolve`/secret key names surface in `mcp_imported_status`, `capabilities_inventory` and `/mcps/proxy/status`.

New `agentproto mcp migrate-secrets [--apply]` (dry-run default) migrates existing literal-secret entries to secret refs.

New `agentproto mcp mount-default <adapter> <importId...>` (P2) lets an adapter natively mount imported MCPs via a managed `harness-<adapter>` bundle, so the adapter spawns with those MCPs mounted by default instead of proxied.

`capabilities_inventory` now reports `alsoNativeIn` (P3): other harness configs that already natively mount the same upstream, identified by normalized url/stdio matching (absolute-path args stripped) with no upstream url/header material leaking into the report.

Settings bundles export secret key names only and report dangling secrets on apply.
