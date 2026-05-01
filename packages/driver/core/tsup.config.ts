import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/driver v0.1.0-alpha
 * AIP-30 DRIVER.md \`defineDriver\` reference implementation.
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["zod", "@agentproto/tool"],
  noExternal: [],
})
