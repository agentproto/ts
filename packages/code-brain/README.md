# @agentproto/code-brain

Pure, backend-agnostic **code-intelligence contract** plus the AIP-14
`ask_codebase` tool, its AIP-30 builtin provider, and thin AIP-29/31/32
surface projections.

This package names **no** concrete code-intelligence engine. A backend
implements the `ICodeBrainProvider` contract in a separate adapter and is
injected via the tool context — which is what lets `ask_codebase` be
authored, typed, and tested against a fake provider *before* any real
backend exists.

## The contract — `ICodeBrainProvider`

```ts
interface ICodeBrainProvider {
  defineSymbol(symbol: string): Promise<SymbolDef | null>
  callers(symbol: string): Promise<readonly CallEdge[]>
  callees(symbol: string): Promise<readonly CallEdge[]>
  graphQuery(query: GraphQuery): Promise<GraphResult>
}
```

It is deliberately idiom-free: no backend's query dialect (source-scoping
flags, define verbs, graph wildcards) appears in these types. Data types:
`SymbolDef`, `CallEdge`, `SourceSpan`, `GraphQuery`, `GraphHit`,
`GraphResult`.

## The tool — `ask_codebase`

`defineTool → implementTool → defineDriver`, mirroring the `worktree.provision`
exemplar. The backend is injected via `contextSchema.codeBrain`; the body
switches on `input.mode`:

| mode        | contract method(s)                     | output |
|-------------|----------------------------------------|--------|
| `blend`     | `graphQuery(...)`                      | `hits` |
| `define`    | `defineSymbol(symbol)`                 | `symbol` |
| `callgraph` | `callers(symbol)` + `callees(symbol)` | `callers`, `callees` |

`mutates: []`, `approval: "auto"`, `idempotent: true`, `riskLevel: 0`.

## Exports

| Subpath | What |
|---|---|
| `.` | contract types + zod schemas + `askCodebaseTool` + `codeBrainProvider` |
| `./types` | the pure contract types + zod mirrors |
| `./tools` | `askCodebaseTool` |
| `./provider` | `codeBrainProvider` (builtin) + `askCodebaseBuiltin` |
| `./mcp` | `defineCodeBrainMcpDriver` — AIP-32 projection |
| `./http` | `defineCodeBrainHttpDriver` — AIP-31 projection |
| `./cli` | `defineCodeBrainCliDriver` — AIP-29 projection |

The projections are wiring only — a later adapter supplies the transport
config (MCP server, HTTP base URL, CLI binary). Nothing connects at import
time and no backend ships in this package.
