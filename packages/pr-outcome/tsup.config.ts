import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: ["@agentproto/runtime"],
  noExternal: [],
})
