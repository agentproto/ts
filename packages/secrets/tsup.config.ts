import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/secrets v0.1.0-alpha
 * AIP-19 SECRETS.md \`defineSecrets\` reference implementation.
 */`,
  entry: {
    index: "src/index.ts",
    "manifest/index": "src/manifest/index.ts",
    "exposure/index": "src/exposure/index.ts",
    "seal/index": "src/seal/index.ts",
    "provision/index": "src/provision/index.ts",
    "provision/recipe/index": "src/provision/recipe/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["zod", "gray-matter", "@agentproto/define-doctype"],
  noExternal: [],
})
