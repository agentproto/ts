import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/workflow-runtime v0.1.0-alpha
 * AIP-15 step-walker over @agentproto/driver runTool.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  dts: true,
  external: ["@agentproto/driver", "@agentproto/tool"],
})
