import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/worktree-agent-example — provision → agent(cwd) → gate → approval → cleanup
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: [
    "@agentproto/driver",
    "@agentproto/tool",
    "@agentproto/workflow-runtime",
    "@agentproto/worktree",
    "zod",
  ],
  noExternal: [],
})
