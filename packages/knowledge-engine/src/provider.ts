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
  KnowledgeProvenance,
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

  /**
   * Mark a source as superseded by another (`by`), or by nothing specific
   * when omitted. Unlike {@link deleteSource} this is not a hard delete: the
   * record and its audit trail survive. Adapters with no native concept of
   * this MUST throw `KnowledgeNotSupportedError` rather than no-op.
   */
  supersede(id: string, by?: string): Promise<void>

  /**
   * Where did this source (or a hit's `sourceId`) come from? Resolves `null`
   * when the id is unknown; throws `KnowledgeNotSupportedError` when the
   * backend has no provenance concept at all (`null` means "unknown id").
   */
  explain(id: string): Promise<KnowledgeProvenance | null>

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
