import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/collect
 * Schemas, ids, URL canonicalisation and text fingerprints for collected public content.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["zod"],
  noExternal: [],
})
