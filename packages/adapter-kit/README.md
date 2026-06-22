# `@agentproto/adapter-kit`

Generic adapter **catalog**, **status**, **creds**, **setup-ledger**, **list/resolve**,
**MCP tool**, and **CLI wizard** primitives shared by the three agentproto adapter
families (agent-CLI, browser, tunnel).

The kit owns the skeleton; each family parameterises it with its own `TInfo`
descriptor and `THandle` (which extends `AdapterHandle`). The runtime keeps
importing zero concrete adapters — everything flows through injected
`load` / `toInfo` callbacks.

## Surface

| Export | Module | Purpose |
|---|---|---|
| `computeStatus` | `./status` | Pure sync `supported \| available \| ready` classifier |
| `makeCredsStore` | `./creds` | File-backed creds store, mode 0600, never leaks value |
| `makeSetupLedger` | `./ledger` | `~/.agentproto/setup/<slug>.json` existence/read/write |
| `makeAdapterResolver`, `makeAdapterLister` | `./list-resolve` | Slug→handle + catalog→entry list |
| `makeListTool`, `makeSetupTool` | `./mcp-tools` | MCP tool factories (`value` param is sensitive) |
| `makeAdapterWizard` | `./wizard` | CLI radio-picker + step runner; skips ledger-completed steps |

See `docs/adapter-kit.md` for the full design.

> Status engine is **pure & sync** (fed pre-resolved booleans). `AdapterHandle.check()`
> is async and **never** invoked during listing — status comes from resolvability
> plus ledger/creds existence only.
