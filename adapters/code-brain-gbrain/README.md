# @agentproto/adapter-code-brain-gbrain

The impure gbrain backing for the pure
[`@agentproto/code-brain`](../../packages/code-brain) `ICodeBrainProvider`
contract. It implements that contract two ways, registers them as a
[`@agentproto/provider-kit`](../../packages/provider-kit) family, ships the
tracked gbrain runtime, and serves the `ask_codebase` tool over MCP.

**Confinement invariant:** every gbrain dialect token (`code-def`, `__all__`,
`--source-id`, `code-callers`, bearer auth) lives in this package and nowhere
else. `@agentproto/code-brain` and everything above it never name gbrain.

## Backends

| Export | Transport | Notes |
|---|---|---|
| `gbrainLocalProvider()` | `docker exec gbrain-pg gbrain …` | Tracked replacement for the untracked `~/agentproto-kb/tools/code-explorer-mcp`. No creds. |
| `gbrainHttpProvider()` | gbrain MCP over `POST /mcp` + `GBRAIN_BEARER_TOKEN` | For a remote/hardened gbrain. |

Both satisfy `ICodeBrainProvider`:

```ts
import { gbrainLocalProvider } from "@agentproto/adapter-code-brain-gbrain"

const brain = gbrainLocalProvider()
await brain.defineSymbol("ImporterRunner")   // → SymbolDef | null
await brain.callers("ImporterRunner")        // → CallEdge[]
await brain.graphQuery({ question: "CorpusImporter enumerate" })  // → GraphResult
```

### gbrain command mapping (verified vs live `gbrain-pg`, v0.42.62.0)

| Contract | Local (CLI) | HTTP (MCP tool) |
|---|---|---|
| `defineSymbol(s)` | `gbrain code-def <s>` → `results[]` | `code_def {symbol}` → `defs[]` |
| `callers(s)` | `gbrain code-callers <s> --all-sources` | `code_callers {symbol, all_sources}` |
| `callees(s)` | `gbrain code-callees <s> --all-sources` | `code_callees {symbol, all_sources}` |
| `graphQuery(q)` | `gbrain query <q> --source-id __all__ --autocut false` (text lines) | `query {query, source_id, autocut}` (JSON array) |

The two backends emit slightly different raw shapes (`results` vs `defs`;
text lines vs JSON array) — both are normalised in `parse.ts`. gbrain's
code-edges carry no source location, so `CallEdge.file` / `.span` are stubbed.

## MCP server

`agentproto-code-brain-gbrain` (bin) / `startAskCodebaseHttpServer(...)` serves
the `ask_codebase` contract over MCP Streamable-HTTP on `127.0.0.1:8831 /mcp`,
byte-compatible with the `code-explorer` alias in
`~/.agentproto/imported-mcps.json`. Pick the backend with
`CODE_BRAIN_MCP_BACKEND=local|http`.

## Runtime

The gbrain launcher (compose + Dockerfile + entrypoints) lives in
[`runtime/`](./runtime) — see its README to bring `gbrain-pg` up.
