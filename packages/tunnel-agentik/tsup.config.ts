import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/tunnel-agentik v0.1.0
 * tunnels.agentik.net implementation of the Tunnel Provider contract.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["@agentproto/tunnel"],
  noExternal: [],
})
