/**
 * Typed capability for accessing the backing engine + workspace path
 * a `CorpusAdapterCore` wraps.
 *
 * The promote-candidate tool needs both to construct a privileged
 * `CorpusInternalWriter` at promote time. Without this capability
 * narrowing, callers would `instanceof CorpusAdapterCore` + check
 * `provider.id === "corpus"`, which violates the no-engineId-switches
 * rule. Narrowing through a structural guard keeps the tool free of
 * engine-identity branches.
 *
 * Lifted VERBATIM from the studio integration package
 * (`packages/integration/knowledge/src/providers/corpus/unwrap.ts`) — the
 * only change is the `IKnowledgeProvider` import path: it now comes from
 * `@agentproto/knowledge-engine` (was `../base-knowledge.provider`).
 */

import type { IKnowledgeProvider } from "@agentproto/knowledge-engine"

export interface CorpusBackingUnwrap {
  unwrapCorpusBacking(): IKnowledgeProvider
  readonly corpusWorkspacePath: string
}

export function isCorpusBackingUnwrap(
  provider: unknown
): provider is CorpusBackingUnwrap {
  if (!provider || typeof provider !== "object") return false
  const candidate = provider as Partial<CorpusBackingUnwrap>
  return (
    typeof candidate.unwrapCorpusBacking === "function" &&
    typeof candidate.corpusWorkspacePath === "string"
  )
}
