import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/adapter-knowledge-gbrain-doc v0.1.0
 * IKnowledgeProvider over a gbrain server's document API (put_page / search)
 * via pure fetch over its JSON-RPC /mcp endpoint, with a provider-kit family.
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
