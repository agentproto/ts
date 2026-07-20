import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/** @agentproto/tool-cli — generic AIP-14 CLI projection. */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["zod", "@agentproto/tool", "@agentproto/driver"],
  noExternal: [],
})
