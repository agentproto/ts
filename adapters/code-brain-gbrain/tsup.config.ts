import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/adapter-code-brain-gbrain v0.1.0
 * ICodeBrainProvider over a live gbrain backend (local docker exec + HTTP/bearer)
 * + provider-kit family + tracked runtime + ask_codebase MCP server.
 */`,
  entry: {
    index: "src/index.ts",
    serve: "src/serve.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: {
    entry: {
      index: "src/index.ts",
    },
  },
  external: [
    "@agentproto/code-brain",
    "@agentproto/provider-kit",
    "@agentproto/tool",
    "@agentproto/driver",
    "@modelcontextprotocol/sdk",
    "zod",
  ],
  noExternal: [],
})
