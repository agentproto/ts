import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/pairing-host
 * Host side of AIP-59 pairing as a library (registry, rendezvous dialer,
 * loopback HTTP forwarder, local-device bearer).
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: ["@agentproto/acp", "@agentproto/secrets", "ws"],
  noExternal: [],
})
