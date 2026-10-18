import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/sandbox-instabox v0.1.0
 * InstaBox SandboxProvider for @agentproto/sandbox.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["@agentproto/sandbox"],
  noExternal: [],
})
