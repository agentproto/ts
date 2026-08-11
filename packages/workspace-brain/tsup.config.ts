import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/workspace-brain v0.1.0
 * Per-workspace brain: indexes workspace session conversations into a
 * queryable BM25 knowledge store via IKnowledgeProvider + corpus importer.
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
    "@agentproto/adapter-knowledge-files",
    "@agentproto/corpus",
    "@agentproto/knowledge-engine",
  ],
  noExternal: [],
})
