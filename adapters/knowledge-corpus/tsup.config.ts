import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/adapter-knowledge-corpus v0.1.0
 * IKnowledgeProvider over an AIP-10 @agentproto/corpus workspace — wraps any
 * backing engine + hydrates AIP-10 provenance + access policy. provider-kit
 * family + node:fs FsPort.
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
