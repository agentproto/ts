import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  entry: { index: "src/index.ts", cli: "src/cli.ts" },
  format: ["esm"],
  splitting: false,
  dts: true,
  banner: "#!/usr/bin/env node",
  external: ["zod", "@modelcontextprotocol/sdk"],
  noExternal: [],
})
