import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/provider-presets v0.1.0-alpha
 * Concrete provider/backend preset registry for Anthropic/OpenAI-compatible adapters.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: [],
  noExternal: [],
})
