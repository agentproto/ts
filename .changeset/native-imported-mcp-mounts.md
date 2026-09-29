---
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

Native imported-MCP mounts via default bundles (P2): `Bundle.mcpImports` may be `"*"` (expands to the current import set at spawn), the bundle expansion loop is extracted into the pure `mountImports`, `agentproto mcp mount-default <adapter> <importId…>` creates/extends bundle `harness-<adapter>` and links it into `defaults.adapters.<adapter>.bundles` (default stays empty), and `capabilities_inventory` reports per-import `reach` (`native` | `indirect` | `none`) per adapter. New `@agentproto/runtime/bundles` export.
