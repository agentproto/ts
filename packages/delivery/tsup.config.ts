import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  entry: { index: "src/index.ts", "ledger-writer": "src/ledger-writer.ts" },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: [],
  noExternal: [],
})
