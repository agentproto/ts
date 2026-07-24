/**
 * Provider body for the `kb_query` TOOL contract. Bound via `implementTool`
 * — typed `input`/`context` flow from the contract handle, mirroring
 * code-brain's `ask-codebase.body.ts`
 * (`packages/code-brain/src/provider/bodies/ask-codebase.body.ts`).
 *
 * Backend-agnostic: reads the host-injected `context.knowledgeEngine`
 * (`IKnowledgeProvider`), dispatches to `query(...)`, and renders a
 * human-readable `answer`. No engine dialect appears here — that is the
 * adapter's job.
 */

import { implementTool } from "@agentproto/driver"
import { kbQueryTool, type KbQueryOutput } from "../../tools/kb-query.tool.js"
import type { KnowledgeHit, KnowledgeQuery, KnowledgeQueryResult } from "../../types.js"

function renderHits(query: string, result: KnowledgeQueryResult): string {
  if (result.modeUsed === "none") {
    return `No recall this turn for "${query}" (engine reported mode 'none').`
  }
  const hits: readonly KnowledgeHit[] = result.hits
  if (hits.length === 0) return `No results for: ${query}`
  const lines = hits.map((hit) => {
    const score = hit.score.toFixed(3)
    return `• [${score}] ${hit.sourceId}#${hit.chunkId}\n  ${hit.text}`
  })
  return (
    `${hits.length} result(s) for "${query}" ` +
    `(engine '${result.engine}', mode '${result.modeUsed}', ${result.tookMs}ms):\n` +
    lines.join("\n")
  )
}

export const kbQueryBuiltin = implementTool(
  kbQueryTool,
  async ({ input, context }): Promise<KbQueryOutput> => {
    const engine = context.knowledgeEngine

    const query: KnowledgeQuery = {
      query: input.query,
      ...(input.topK !== undefined ? { topK: input.topK } : {}),
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
      ...(input.filter !== undefined ? { filter: input.filter } : {}),
    }

    const result = await engine.query(query)

    return {
      answer: renderHits(input.query, result),
      hits: result.hits,
      tookMs: result.tookMs,
      engine: result.engine,
      modeUsed: result.modeUsed,
    }
  },
)
