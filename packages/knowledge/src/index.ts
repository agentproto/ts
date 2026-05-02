/**
 * @agentproto/knowledge — AIP-10 KNOWLEDGE.md `defineKnowledge` reference impl.
 *
 * A filesystem-first knowledge-base format where an LLM curates, links, and lints a markdown wiki on top of immutable raw sources, turning agent knowledge into a compounding artifact instead of a per-query retrieval miss.
 *
 * Spec: https://agentproto.sh/docs/aip-10
 *
 * Authoring paths:
 *   - TS:  `defineKnowledge({...})` → `KnowledgeHandle`
 *   - MD:  `parseKnowledgeManifest(src) → knowledgeFromManifest({...})` → `KnowledgeHandle`
 */

export const SPEC_NAME = "agentknowledge/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineKnowledge } from "./define-knowledge.js"
export type { KnowledgeDefinition, KnowledgeHandle } from "./types.js"
