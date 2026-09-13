import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/app-config v0.1.0
 * Layered YAML config kit for agentproto apps (defaults → entry → item file).
 */`,
  entry: { index: "src/index.ts", cli: "src/cli.ts" },
  format: ["esm"],
  splitting: false,
  dts: false,
  external: ["yaml", "zod"],
  noExternal: [],
})
