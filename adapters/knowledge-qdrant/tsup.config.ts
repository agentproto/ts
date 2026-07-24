import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/adapter-knowledge-qdrant v0.1.0
 * IKnowledgeProvider over a Qdrant collection via pure fetch (upsert/search)
 * + OpenAI-compatible embeddings, with optional tenant-scoped payload
 * filtering + a provider-kit family.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: {
    entry: {
      index: "src/index.ts",
    },
  },
  external: [
    "@agentproto/knowledge-engine",
    "@agentproto/provider-kit",
  ],
  noExternal: [],
})
