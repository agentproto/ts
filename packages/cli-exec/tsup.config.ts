import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/cli-exec v0.1.0-alpha
 * One-shot CLI execution: spawn + stdin + capture, with a JSON-envelope parser.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: ["node:child_process"],
  noExternal: [],
})
