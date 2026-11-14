import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/adapter-mastra-controller
 * AIP-45 proprietary protocol arm for a Mastra AgentController declared
 * by a mastra.agent-controller/v1 manifest.
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["@agentproto/harness", "@mastra/core", "gray-matter", "zod"],
  noExternal: [],
})
