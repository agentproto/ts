/**
 * Provider body for the `kb_ingest` TOOL contract. Bound via `implementTool`
 * — typed `input`/`context` flow from the contract handle, mirroring
 * code-brain's `ask-codebase.body.ts`
 * (`packages/code-brain/src/provider/bodies/ask-codebase.body.ts`).
 *
 * Backend-agnostic: reads the host-injected `context.knowledgeEngine`
 * (`IKnowledgeProvider`), dispatches to `ingest(...)`, and renders a
 * human-readable `answer`. No engine dialect appears here.
 */

import { implementTool } from "@agentproto/driver"
import { kbIngestTool, type KbIngestOutput } from "../../tools/kb-ingest.tool.js"
import type { KnowledgeIngestInput, KnowledgeSource } from "../../types.js"

function renderSource(source: KnowledgeSource): string {
  const title = source.title !== undefined ? ` "${source.title}"` : ""
  const err = source.error !== undefined ? ` — error: ${source.error}` : ""
  return (
    `Ingested ${source.kind}${title} as source ${source.id} ` +
    `(${source.bytes} bytes, status '${source.status}')${err}.`
  )
}

export const kbIngestBuiltin = implementTool(
  kbIngestTool,
  async ({ input, context }): Promise<KbIngestOutput> => {
    const engine = context.knowledgeEngine

    const ingestInput: KnowledgeIngestInput = {
      kind: input.kind,
      uri: input.uri,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    }

    const source = await engine.ingest(ingestInput)

    return {
      answer: renderSource(source),
      source,
    }
  },
)
