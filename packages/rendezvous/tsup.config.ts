import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/rendezvous v0.1.0-alpha
 * Untrusted ciphertext splicer for E2E daemon pairing — matches two sockets on a
 * one-time token and pipes their bytes verbatim. Never sees plaintext.
 */`,
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: [
    "ws",
    "node:http",
    "node:crypto",
    "node:url",
  ],
  noExternal: [],
})
