import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/sandbox-e2b v0.1.0-alpha
 * e2b SandboxProvider for @agentproto/sandbox.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["@agentproto/sandbox", "e2b"],
  noExternal: [],
})
