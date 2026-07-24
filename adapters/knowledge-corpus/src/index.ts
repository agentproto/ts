/**
 * @agentproto/adapter-knowledge-corpus — the AIP-10 corpus-composition
 * backing for the `@agentproto/knowledge-engine` `IKnowledgeProvider`
 * contract.
 *
 * Ships the contract implementation ({@link CorpusAdapterCore}) over an AIP-10
 * `@agentproto/corpus` workspace: it wraps any backing `IKnowledgeProvider`
 * (the files adapter, or an external vector store), hydrates every hit with
 * canonical provenance +
 * temporal score, enforces the corpus access policy, and rejects public
 * ingest/delete (writes go through the privileged {@link CorpusInternalWriter}).
 * A `node:fs` {@link LocalFs} `FsPort` + {@link createStandaloneCorpusAdapter}
 * let it run standalone, and a provider-kit family registers it under the
 * `@agentproto/adapter-knowledge-*` discovery convention. Every corpus
 * hydration/access idiom is confined to this package — the
 * `@agentproto/knowledge-engine` contract and everything above it stay
 * backend-agnostic. The composition sibling of
 * `@agentproto/adapter-knowledge-files`.
 */

// adapter (IKnowledgeProvider implementation)
export {
  CorpusAdapterCore,
  CORPUS_ENGINE_ID,
  type CorpusAdapterCoreOptions,
} from "./adapter.js"

// privileged write path (NOT an IKnowledgeProvider)
export {
  CorpusInternalWriter,
  type CorpusInternalWriterOptions,
  type CorpusEntryChunk,
  type PushChunksInput,
} from "./internal-writer.js"

// typed backing-unwrap capability
export {
  isCorpusBackingUnwrap,
  type CorpusBackingUnwrap,
} from "./unwrap.js"

// hydration + provenance helpers
export {
  buildCorpusIndex,
  computeTemporalScore,
  hydrateHit,
  type CorpusIndex,
} from "./hydrate.js"

// typed metadata.corpus.* accessors
export {
  readCorpusBlock,
  readCorpusFrontmatter,
  readCorpusTemporal,
  type CorpusFrontmatter,
  type CorpusSourceRef,
  type CorpusTemporal,
} from "./frontmatter.js"

// standalone backing (node:fs FsPort + empty backing + factory)
export { LocalFs, type LocalFsOptions } from "./local-fs.js"
export { createEmptyBacking, EMPTY_BACKING_ID } from "./empty-backing.js"
export {
  createStandaloneCorpusAdapter,
  type CreateStandaloneCorpusAdapterOptions,
} from "./standalone.js"

// typed env
export {
  loadCorpusKnowledgeEnv,
  type CorpusKnowledgeEnv,
} from "./env.js"

// provider-kit family
export {
  KNOWLEDGE_FAMILY,
  CORPUS_SLUG,
  KNOWLEDGE_CORPUS_CATALOG,
} from "./catalog.js"
export {
  resolveKnowledgeBackend,
  makeKnowledgeCorpusResolver,
  type KnowledgeCorpusInfo,
  type KnowledgeHandle,
} from "./handle.js"
