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
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: [
    "@agentproto/driver",
    "@agentproto/tool",
    "zod",
    "node:child_process",
    "node:fs",
    "node:fs/promises",
    "node:path",
  ],
  noExternal: [],
})
