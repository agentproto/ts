/**
 * @agentproto/code-brain — the pure code-intelligence contract + the
 * `ask_codebase` tool.
 *
 * This package is backend-agnostic: it defines `ICodeBrainProvider` (the
 * net-new symbol/callgraph/query contract), the AIP-14 `ask_codebase` tool,
 * its AIP-30 builtin provider, and thin AIP-29/31/32 surface projections. It
 * takes NO dependency on any concrete code-intelligence engine — a backend
 * implements `ICodeBrainProvider` in a separate adapter and is injected via
 * the tool context. That separation is what lets `ask_codebase` be authored
 * and tested against a fake provider before any real backend exists.
 */

export {
  type ICodeBrainProvider,
  type SymbolDef,
  type CallEdge,
  type SourceSpan,
  type GraphQuery,
  type GraphHit,
  type GraphResult,
  type CodeBrainToolContext,
  sourceSpanSchema,
  symbolDefSchema,
  callEdgeSchema,
  graphHitSchema,
  codeBrainProviderSchema,
  codeBrainToolContextSchema,
} from "./types.js"

export { askCodebaseTool } from "./tools/index.js"
export { codeBrainProvider, askCodebaseBuiltin } from "./provider/index.js"
export { queryManySources } from "./query-many-sources.js"
