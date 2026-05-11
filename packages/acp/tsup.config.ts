import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/acp v0.1.0-alpha
 * AIP-44 ACP.md \`defineAcp\` reference implementation.
 */`,
  entry: {
    index: "src/index.ts",
    "manifest/index": "src/manifest/index.ts",
    "client/index": "src/client/index.ts",
    "server/index": "src/server/index.ts",
    "tunnel/index": "src/tunnel/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: [
    "zod",
    "gray-matter",
    "@agentproto/define-doctype",
    "@agentclientprotocol/sdk",
  ],
  noExternal: [],
})
