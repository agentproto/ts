import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/extension v0.1.0-alpha
 * AIP-40 EXTENSION.md \`defineExtension\` reference implementation.
 */`,
  entry: {
    index: "src/index.ts",
    "manifest/index": "src/manifest/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: [
    "zod",
    "gray-matter",
    "@agentproto/define-doctype",
    "@agentproto/manifest",
  ],
  noExternal: [],
})
