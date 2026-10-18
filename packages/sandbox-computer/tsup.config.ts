import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/sandbox-computer v0.1.0
 * `+"\n"+` * Self-hosted microVM "computer" SandboxProvider for @agentproto/sandbox.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["@agentproto/sandbox", "zod"],
  noExternal: [],
})
