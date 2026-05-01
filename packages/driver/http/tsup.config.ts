import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/http v0.1.0-alpha
 * AIP-31 HTTP provider specialisation.
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["@agentproto/driver", "@agentproto/tool"],
  noExternal: [],
})
