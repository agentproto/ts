import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/knowledge-cascade v0.1.0
 * Global knowledge pack + per-scope override/extend/whiteout over plain
 * file trees. Re-exports the cascade primitive from @agentproto/corpus.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: ["@agentproto/corpus"],
  noExternal: [],
})
