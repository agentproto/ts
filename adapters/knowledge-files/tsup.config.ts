import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/adapter-knowledge-files v0.1.0
 * IKnowledgeProvider over local files with an in-process BM25 index
 * (no embeddings, no network) + provider-kit family + node:fs FsPort.
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
    "@agentproto/corpus",
    "@agentproto/provider-kit",
  ],
  noExternal: [],
})
