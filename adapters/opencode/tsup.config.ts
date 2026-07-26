import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/adapter-opencode v0.1.0-alpha
 * AIP-45 adapter for sst/opencode via its built-in \`opencode acp\` mode.
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["@agentproto/driver-agent-cli", "@agentproto/model-catalog"],
  noExternal: [],
})
