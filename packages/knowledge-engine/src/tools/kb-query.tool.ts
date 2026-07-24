import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { knowledgeToolContextSchema } from "../provider.js"
import { knowledgeHitSchema, knowledgeQueryModeSchema } from "../types.js"

/** `kb_query` input schema — a retrieval query over the injected engine. */
export const kbQueryInputSchema = z.object({
  query: z.string().min(1).describe("The natural-language retrieval query."),
  topK: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max hits to return. Engine applies its own default when omitted."),
  mode: knowledgeQueryModeSchema
    .optional()
    .describe(
      "Retrieval mode HINT — 'vector' | 'graph' | 'hybrid' | 'none'. Engines " +
        "that don't support the requested mode fall back and echo the actual " +
        "mode used in `modeUsed`. Omit to let the engine pick.",
    ),
  minScore: z
    .number()
    .optional()
    .describe("Drop hits scoring below this threshold."),
  filter: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Engine-specific predicate (e.g. metadata filters). Opaque to this " +
        "contract; engines ignore keys they don't recognise.",
    ),
})

/** `kb_query` output schema — the engine's result plus a rendered `answer`. */
export const kbQueryOutputSchema = z.object({
  answer: z.string().describe("Human-readable rendering of the hits."),
  hits: z
    .array(knowledgeHitSchema)
    .readonly()
    .describe("Ranked hits returned by the engine."),
  tookMs: z.number().nonnegative().describe("Engine-reported query latency."),
  engine: z.string().describe("Adapter id that served the query."),
  modeUsed: knowledgeQueryModeSchema.describe(
    "The mode actually used (may differ from the requested `mode`).",
  ),
})

export type KbQueryInput = z.infer<typeof kbQueryInputSchema>
export type KbQueryOutput = z.infer<typeof kbQueryOutputSchema>

/**
 * AIP-14 contract for `kb_query` — retrieval over the injected knowledge
 * engine. Mirrors code-brain's `ask_codebase`
 * (`packages/code-brain/src/tools/ask-codebase.tool.ts:66`): a pure
 * `defineTool` handle carrying only schemas + governance metadata; the body
 * lives on the AIP-30 provider.
 *
 * The backend is injected via `contextSchema.knowledgeEngine` (an
 * `IKnowledgeProvider`), so this contract names no engine — the body
 * dispatches to `knowledgeEngine.query(...)`. Read-only.
 */
export const kbQueryTool = defineTool({
  id: "kb_query",
  description:
    "Query a knowledge base via the injected knowledge engine and return " +
    "ranked hits. `mode` is a retrieval hint (vector/graph/hybrid/none) that " +
    "the engine may fall back on — the mode actually used is echoed in " +
    "`modeUsed`. `topK`, `minScore`, and `filter` narrow the result. " +
    "Read-only — never mutates the knowledge base.",
  version: "0.1.0",
  inputSchema: kbQueryInputSchema,
  outputSchema: kbQueryOutputSchema,
  contextSchema: knowledgeToolContextSchema,
  mutates: [],
  approval: "auto",
  idempotent: true,
  riskLevel: 0,
})
