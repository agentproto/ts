/**
 * @agentproto/knowledge-engine — the pure `IKnowledgeProvider` contract.
 *
 * Lifted VERBATIM from the studio integration package
 * (`packages/integration/knowledge/src/providers/base-knowledge.provider.ts:14-27`)
 * — the interface already imported only its own data types and carried no
 * `@guilde/@simone/@agstudio` edge, so it re-homes as-is. The only change is
 * the import path (`../types/knowledge.types` → `./types.js`) to fit the new
 * package boundary. This is the retrieval sibling of code-brain's
 * `ICodeBrainProvider`.
 */

import type {
  KnowledgeCapabilities,
  KnowledgeIngestInput,
  KnowledgeQuery,
  KnowledgeQueryResult,
  KnowledgeSource,
  ListSourcesFilter,
} from "./types.js"
import { z } from "zod"

/**
 * Knowledge provider contract. One implementation per engine
 * (the engine name lives in the adapter, never in this contract).
 */
export interface IKnowledgeProvider {
  /** Adapter id — the concrete engine names itself here. */
  readonly id: string
  readonly capabilities: KnowledgeCapabilities

  ingest(input: KnowledgeIngestInput): Promise<KnowledgeSource>
  query(q: KnowledgeQuery): Promise<KnowledgeQueryResult>
  listSources(filter?: ListSourcesFilter): Promise<readonly KnowledgeSource[]>
  getSource(id: string): Promise<KnowledgeSource | null>
  deleteSource(id: string): Promise<void>

  healthCheck(): Promise<boolean>
  dispose(): Promise<void>
}

/**
 * Zod mirror of {@link IKnowledgeProvider} for the tool `contextSchema`.
 * The provider is a live object with methods; zod can't deep-validate its
 * behaviour, so — exactly like code-brain's `codeBrainProviderSchema`
 * (`packages/code-brain/src/types.ts`) and `@agentproto/governance`'s
 * host-injected `filesystem` — its presence is asserted with `z.custom` and
 * its methods are exercised by the tool bodies downstream.
 */
export const knowledgeProviderSchema: z.ZodType<IKnowledgeProvider> =
  z.custom<IKnowledgeProvider>(
    (value) => typeof value === "object" && value !== null,
  )

/**
 * The `kb_query` / `kb_ingest` tool context: the host injects an
 * {@link IKnowledgeProvider} at invocation time, so the tool bodies stay
 * backend-agnostic. Mirrors code-brain's `codeBrainToolContextSchema`.
 */
export const knowledgeToolContextSchema = z.object({
  knowledgeEngine: knowledgeProviderSchema,
})

export type KnowledgeToolContext = z.infer<typeof knowledgeToolContextSchema>
