import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/memory
 * AIP-72 memory/v1 \`defineMemory\` reference implementation.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["zod", "yaml", "@agentproto/doctype"],
  noExternal: [],
})
