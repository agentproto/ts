import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/agencies-mastra v0.1.0-alpha
 * Mastra adapter for agentagencies/v1.
 */`,
  entry: { index: "src/index.ts", codegen: "src/codegen.ts" },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: [
    "@agentproto/agencies",
    "@agentproto/governance",
    "@agentproto/governance-mastra",
    "@mastra/core",
    "zod",
  ],
})
