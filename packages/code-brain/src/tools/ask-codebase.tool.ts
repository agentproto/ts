import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import {
  callEdgeSchema,
  codeBrainToolContextSchema,
  graphHitSchema,
  symbolDefSchema,
} from "../types.js"

/** `ask_codebase` input schema — the dispatch mode + its arguments. */
export const askCodebaseInputSchema = z.object({
  question: z.string().min(1).describe("The natural-language question to answer."),
  mode: z
    .enum(["blend", "define", "callgraph"])
    .default("blend")
    .describe("Dispatch strategy. Default 'blend'."),
  symbol: z
    .string()
    .optional()
    .describe("Fully-qualified symbol name — required for 'define' and 'callgraph'."),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max hits for 'blend' mode. Backend applies its own default when omitted."),
})

/** `ask_codebase` output schema — a `mode`-tagged, per-mode-populated result. */
export const askCodebaseOutputSchema = z.object({
  mode: z.enum(["blend", "define", "callgraph"]),
  answer: z.string().describe("Human-readable rendering of the result."),
  hits: z.array(graphHitSchema).readonly().optional().describe("Ranked hits — 'blend' mode only."),
  symbol: symbolDefSchema
    .nullable()
    .optional()
    .describe("Resolved definition, or null when unknown — 'define' mode only."),
  callers: z
    .array(callEdgeSchema)
    .readonly()
    .optional()
    .describe("Inbound edges — 'callgraph' mode only."),
  callees: z
    .array(callEdgeSchema)
    .readonly()
    .optional()
    .describe("Outbound edges — 'callgraph' mode only."),
})

export type AskCodebaseInput = z.infer<typeof askCodebaseInputSchema>
export type AskCodebaseOutput = z.infer<typeof askCodebaseOutputSchema>

/**
 * AIP-14 contract for `ask_codebase` — the single tool the code-brain
 * subsystem exposes. Mirrors the `worktree.provision` exemplar
 * (`packages/worktree/src/tools/provision-worktree.tool.ts:9`): a pure
 * `defineTool` handle carrying only schemas + governance metadata; the body
 * lives on the AIP-30 provider.
 *
 * The backend is injected via `contextSchema.codeBrain` (an
 * `ICodeBrainProvider`), so this contract names no backend. `mode` selects
 * which contract method the body dispatches to:
 *   - `blend`     → `codeBrain.graphQuery(...)`     (free-form federated query)
 *   - `define`    → `codeBrain.defineSymbol(symbol)`
 *   - `callgraph` → `codeBrain.callers(symbol)` + `codeBrain.callees(symbol)`
 */
export const askCodebaseTool = defineTool({
  id: "ask_codebase",
  description:
    "Answer a question about a codebase via the injected code-brain " +
    "backend. `mode` picks the strategy: 'blend' runs a free-form " +
    "federated query and returns ranked hits; 'define' resolves a single " +
    "`symbol` to its definition; 'callgraph' returns the callers and " +
    "callees of `symbol`. `symbol` is required for 'define' and " +
    "'callgraph'. Read-only — never mutates the codebase.",
  version: "0.1.0",
  inputSchema: askCodebaseInputSchema,
  outputSchema: askCodebaseOutputSchema,
  contextSchema: codeBrainToolContextSchema,
  mutates: [],
  approval: "auto",
  idempotent: true,
  riskLevel: 0,
})
