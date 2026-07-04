import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/worktree v0.1.0
 * git-worktree provision / gate / cleanup TOOL contracts + builtin PROVIDER.
 */`,
  entry: {
    index: "src/index.ts",
    "tools/index": "src/tools/index.ts",
    "provider/index": "src/provider/index.ts",
    "bin/worktree-agent": "src/bin/worktree-agent.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: { entry: { index: "src/index.ts", "tools/index": "src/tools/index.ts", "provider/index": "src/provider/index.ts" } },
  external: [
    "@agentproto/driver",
    "@agentproto/harness",
    "@agentproto/tool",
    "@agentproto/workflow-runtime",
    "@modelcontextprotocol/sdk",
    "zod",
    "node:child_process",
    "node:fs",
    "node:fs/promises",
    "node:path",
    "node:readline",
    "node:process",
  ],
  noExternal: [],
})
