import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/pair-client
 * Browser-safe client for agentproto E2E daemon pairing — pair from an offer,
 * then fetch through the daemon over an end-to-end encrypted rendezvous tunnel.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: ["@agentproto/acp", "@agentproto/secrets"],
  noExternal: [],
})
