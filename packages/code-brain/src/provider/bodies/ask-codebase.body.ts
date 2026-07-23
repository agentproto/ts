/**
 * Provider body for the `ask_codebase` TOOL contract. Bound via
 * `implementTool` — typed `input`/`context` flow from the contract handle,
 * mirroring `packages/worktree/src/provider/bodies/provision-worktree.body.ts:13`.
 *
 * The body is backend-agnostic: it reads the host-injected
 * `context.codeBrain` (`ICodeBrainProvider`) and dispatches over `input.mode`
 * to the matching contract method, then renders a human-readable `answer`.
 * No backend dialect appears here — that is the adapter's job.
 */

import { implementTool } from "@agentproto/driver"
import { ToolError } from "@agentproto/tool"
import {
  askCodebaseTool,
  type AskCodebaseOutput,
} from "../../tools/ask-codebase.tool.js"
import type { CallEdge, GraphHit, SymbolDef } from "../../types.js"

function requireSymbol(mode: string, symbol: string | undefined): string {
  if (symbol === undefined || symbol.length === 0) {
    throw new ToolError({
      code: "input_invalid",
      message: `ask_codebase: mode '${mode}' requires a 'symbol'`,
      cause: { field: "symbol" },
    })
  }
  return symbol
}

function renderHits(question: string, hits: readonly GraphHit[]): string {
  if (hits.length === 0) return `No results for: ${question}`
  const lines = hits.map((hit) => {
    const where = hit.file !== undefined ? ` (${hit.file})` : ""
    return `• ${hit.title}${where}\n  ${hit.body}`
  })
  return `${hits.length} result(s) for "${question}":\n${lines.join("\n")}`
}

function renderSymbol(symbol: string, def: SymbolDef | null): string {
  if (def === null) return `No definition found for symbol '${symbol}'.`
  const doc = def.doc !== undefined ? `\n${def.doc}` : ""
  return `${def.symbol} (${def.kind}) — ${def.file}:${def.span.startLine}\n${def.signature}${doc}`
}

function renderCallgraph(
  symbol: string,
  callers: readonly CallEdge[],
  callees: readonly CallEdge[],
): string {
  return `${symbol}: ${callers.length} caller(s), ${callees.length} callee(s).`
}

export const askCodebaseBuiltin = implementTool(
  askCodebaseTool,
  async ({ input, context }): Promise<AskCodebaseOutput> => {
    const codeBrain = context.codeBrain

    switch (input.mode) {
      case "blend": {
        const result = await codeBrain.graphQuery({
          question: input.question,
          ...(input.symbol !== undefined ? { scope: input.symbol } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        return {
          mode: "blend",
          answer: renderHits(input.question, result.hits),
          hits: result.hits,
        }
      }
      case "define": {
        const symbol = requireSymbol("define", input.symbol)
        const def = await codeBrain.defineSymbol(symbol)
        return {
          mode: "define",
          answer: renderSymbol(symbol, def),
          symbol: def,
        }
      }
      case "callgraph": {
        const symbol = requireSymbol("callgraph", input.symbol)
        const [callers, callees] = await Promise.all([
          codeBrain.callers(symbol),
          codeBrain.callees(symbol),
        ])
        return {
          mode: "callgraph",
          answer: renderCallgraph(symbol, callers, callees),
          callers,
          callees,
        }
      }
      default: {
        const exhaustive: never = input.mode
        throw new ToolError({
          code: "input_invalid",
          message: `ask_codebase: unrecognised mode '${String(exhaustive)}'`,
          cause: { field: "mode" },
        })
      }
    }
  },
)
