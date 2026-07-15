import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/providers-store v0.1.0
 * The ~/.agentproto/providers.json LLM provider API-key store + env injection.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: ["@agentproto/model-catalog"],
  noExternal: [],
})
