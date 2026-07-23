import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/code-brain v0.1.0
 * Pure code-intelligence contract + ask_codebase TOOL + surface projections.
 */`,
  entry: {
    index: "src/index.ts",
    types: "src/types.ts",
    "tools/index": "src/tools/index.ts",
    "provider/index": "src/provider/index.ts",
    "mcp/index": "src/mcp/index.ts",
    "http/index": "src/http/index.ts",
    "cli/index": "src/cli/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: {
    entry: {
      index: "src/index.ts",
      types: "src/types.ts",
      "tools/index": "src/tools/index.ts",
      "provider/index": "src/provider/index.ts",
      "mcp/index": "src/mcp/index.ts",
      "http/index": "src/http/index.ts",
      "cli/index": "src/cli/index.ts",
    },
  },
  external: [
    "@agentproto/tool",
    "@agentproto/driver",
    "@agentproto/driver-mcp",
    "@agentproto/driver-http",
    "@agentproto/driver-cli",
    "zod",
  ],
  noExternal: [],
})
