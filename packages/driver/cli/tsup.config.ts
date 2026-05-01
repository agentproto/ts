import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/cli v0.1.0-alpha
 * AIP-29 CLI provider specialisation.
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["@agentproto/driver", "@agentproto/tool", "node:child_process"],
  noExternal: [],
})
