---
"@agentproto/provider-kit": minor
---

Add `makeProviderFamily()`, the glue sandbox and tunnels each copied: static catalog, `supported | available | ready` listing, slug to provider resolution (built-ins or a dynamic import of the provider package), cross-provider setup schema and `setup`, and the MCP `list_*` / `setup_*` tools. Also add `makeEnvCredsStore` (read-only, environment variables), `makeMemoryCredsStore` and `makeMemorySetupLedger`, so a family runs with no daemon and no `~/.agentproto`. Purely additive; existing exports are unchanged.
