import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/sandbox-box v0.1.0
 * ascii.dev Box SandboxProvider for @agentproto/sandbox.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["@agentproto/sandbox", "@asciidev/box-sdk"],
  noExternal: [],
})
