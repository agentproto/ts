import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/sdk v0.1.0
 * Umbrella entry point over the AIP-14/30/42/44 primitives + \`createAgent\`.
 */`,
  entry: {
    index: "src/index.ts",
    acp: "src/acp.ts",
    server: "src/server.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: [
    "zod",
    "@agentproto/tool",
    "@agentproto/agent",
    "@agentproto/driver",
    "@agentproto/acp",
    "@agentproto/acp/client",
    "@agentproto/acp/server",
    "@agentproto/runtime",
  ],
  noExternal: [],
})
