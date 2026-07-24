/**
 * @agentproto/adapter-knowledge-files — the pure, zero-runtime files backing
 * for the `@agentproto/knowledge-engine` `IKnowledgeProvider` contract.
 *
 * Ships the contract implementation ({@link FilesKnowledgeAdapter}) over local
 * files with an in-process BM25 index (no embeddings, no network, no API key),
 * a `node:fs` {@link LocalFs} `FsPort` so it runs standalone, and a
 * provider-kit family that registers it under the `@agentproto/adapter-
 * knowledge-*` discovery convention. Every BM25 index/query idiom is confined
 * to this package — `@agentproto/knowledge-engine` and everything above it
 * stay backend-agnostic. The retrieval sibling of
 * `@agentproto/adapter-code-brain-gbrain`.
 */

// adapter (IKnowledgeProvider implementation)
export {
  FilesKnowledgeAdapter,
  FILES_ENGINE_ID,
  FILES_CAPABILITIES,
  type FilesAdapterConfig,
  type FilesKnowledgeAdapterOptions,
} from "./adapter.js"

// standalone backing (node:fs FsPort + factory)
export { LocalFs, type LocalFsOptions } from "./local-fs.js"
export { createStandaloneFilesAdapter } from "./standalone.js"

// typed env
export {
  loadFilesKnowledgeEnv,
  type FilesKnowledgeEnv,
} from "./env.js"

// in-process BM25 index
export {
  tokenize,
  buildIndex,
  buildIndexYielding,
  score,
  type Bm25Doc,
  type Bm25Index,
  type BuildDocInput,
  type ScoredHit,
} from "./bm25.js"

// provider-kit family
export {
  KNOWLEDGE_FAMILY,
  FILES_BM25_SLUG,
  KNOWLEDGE_FILES_CATALOG,
} from "./catalog.js"
export {
  resolveKnowledgeBackend,
  makeKnowledgeFilesResolver,
  type KnowledgeFilesInfo,
  type KnowledgeHandle,
} from "./handle.js"
