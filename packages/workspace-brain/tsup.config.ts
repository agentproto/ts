import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/workspace-brain v0.1.0
 * Per-workspace brain: indexes workspace session conversations into a
 * queryable knowledge store via IKnowledgeProvider + corpus importer.
 * Queryable over any of the knowledge adapters (files / gbrain-doc / qdrant),
 * federated and merged by the provider resolver.
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
    "@agentproto/adapter-knowledge-gbrain-doc",
    "@agentproto/adapter-knowledge-qdrant",
    "@agentproto/corpus",
    "@agentproto/knowledge-engine",
    "zod",
  ],
  noExternal: [],
})
