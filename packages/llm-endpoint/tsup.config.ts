import { createTsupConfig } from "@agentproto/tooling/tsup/base"

const entry = {
  index: "src/index.ts",
  cli: "src/cli.ts",
}

export default createTsupConfig({
  banner: `/**
 * @agentproto/llm-endpoint (deprecated shim)
 * Re-exports @agentproto/inference-endpoint unchanged.
 */`,
  entry,
  format: ["esm"],
  splitting: false,
  dts: { entry: { index: "src/index.ts" } },
  external: ["@agentproto/inference-endpoint", "@agentproto/inference-endpoint/*"],
  noExternal: [],
})
