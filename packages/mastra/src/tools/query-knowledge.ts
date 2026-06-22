/**
 * makeQueryKnowledgeTool — tool factory for on-demand knowledge recall.
 *
 * Returns a `{ name, tool }` pair where `tool` is a Mastra-compatible
 * object (id / description / execute) closed over a `CorpusHost`. Pass
 * the result directly as a resolved tool in `buildMastraAgent`'s
 * `resolveTool` callback, or register it in your tool catalog.
 *
 * The `execute` function is also directly testable without a running
 * Mastra agent — it just calls `host.resolveKnowledgeEntries`.
 */

import type { CorpusHost, CorpusEntryQuery, ResolvedEntry, Dimensions } from "@agentproto/corpus"

export interface QueryKnowledgeToolOptions {
  readonly host: CorpusHost
  /** Extract the scope id from the Mastra tool execution context. */
  readonly getScopeId: (context: unknown) => string | undefined
  /** Optionally extract dimensions to influence stack resolution. */
  readonly getDimensions?: (context: unknown) => Dimensions | undefined
}

export interface QueryKnowledgeInput {
  /** Match entries sharing any of these tags. */
  readonly tags?: string[]
  /** Free-text query (currently passed as a tag hint; semantic search TBD). */
  readonly query?: string
}

export interface QueryKnowledgeTool {
  readonly name: string
  readonly tool: {
    readonly id: string
    readonly description: string
    execute(
      input: QueryKnowledgeInput,
      context: unknown
    ): Promise<readonly ResolvedEntry[]>
  }
}

/**
 * Create a `query_knowledge` tool that resolves entries from the
 * `CorpusHost` for the request's scope. Wire into `buildMastraAgent`
 * via `resolveTool` when a corpus host is available:
 *
 * ```ts
 * const kbTool = makeQueryKnowledgeTool({ host, getScopeId })
 * buildMastraAgent(handle, {
 *   resolveTool: (ref) =>
 *     ref === "corpus:query_knowledge" ? kbTool : undefined,
 *   ...
 * })
 * ```
 */
export function makeQueryKnowledgeTool(
  opts: QueryKnowledgeToolOptions
): QueryKnowledgeTool {
  return {
    name: "query_knowledge",
    tool: {
      id: "corpus:query_knowledge",
      description:
        "Query the attached knowledge base for entries matching the given tags or text query.",
      execute: async (input, context) => {
        const scopeId = opts.getScopeId(context)
        if (!scopeId) return []
        const dimensions = opts.getDimensions?.(context)
        const q: CorpusEntryQuery = {
          ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
        }
        return opts.host.resolveKnowledgeEntries(scopeId, q, dimensions)
      },
    },
  }
}
