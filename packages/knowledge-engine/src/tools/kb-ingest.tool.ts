import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { knowledgeToolContextSchema } from "../provider.js"
import {
  knowledgeMetadataSchema,
  knowledgeSourceKindSchema,
  knowledgeSourceSchema,
} from "../types.js"

/** `kb_ingest` input schema — a single source to add to the KB. */
export const kbIngestInputSchema = z.object({
  kind: knowledgeSourceKindSchema.describe(
    "Source kind — 'file' | 'url' | 'text' | 'connector'.",
  ),
  uri: z.string().min(1).describe("Locator for the source (path, URL, or synthetic id)."),
  title: z.string().optional().describe("Human-readable title."),
  content: z
    .union([z.instanceof(Uint8Array), z.string()])
    .optional()
    .describe(
      "Optional inline payload. Adapters that index by URI may ignore this.",
    ),
  mimeType: z.string().optional().describe("MIME type of `content`, when known."),
  metadata: knowledgeMetadataSchema
    .optional()
    .describe("Opaque metadata blob attached to the source."),
})

/** `kb_ingest` output schema — the created source plus a rendered `answer`. */
export const kbIngestOutputSchema = z.object({
  answer: z.string().describe("Human-readable summary of the ingested source."),
  source: knowledgeSourceSchema.describe("The source record the engine created."),
})

export type KbIngestInput = z.infer<typeof kbIngestInputSchema>
export type KbIngestOutput = z.infer<typeof kbIngestOutputSchema>

/**
 * AIP-14 contract for `kb_ingest` — add a source to the injected knowledge
 * engine. Same authoring shape as `kb_query` and code-brain's `ask_codebase`
 * (`packages/code-brain/src/tools/ask-codebase.tool.ts:66`): schemas +
 * governance metadata only; the body lives on the AIP-30 provider and
 * dispatches to `knowledgeEngine.ingest(...)`.
 *
 * Unlike `kb_query`, this MUTATES the knowledge base, so it is marked
 * non-idempotent and declares the `knowledge_source` resource it writes.
 */
export const kbIngestTool = defineTool({
  id: "kb_ingest",
  description:
    "Ingest a single source (file/url/text/connector) into a knowledge base " +
    "via the injected knowledge engine and return the created source record. " +
    "`content` is an optional inline payload; URI-indexing engines may ignore " +
    "it. Mutating — adds/updates a source in the knowledge base.",
  version: "0.1.0",
  inputSchema: kbIngestInputSchema,
  outputSchema: kbIngestOutputSchema,
  contextSchema: knowledgeToolContextSchema,
  mutates: ["knowledge_source"],
  approval: "auto",
  idempotent: false,
  riskLevel: 1,
})
