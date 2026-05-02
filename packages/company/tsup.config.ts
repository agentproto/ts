import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/company v0.1.0-alpha
 * AIP-6 COMPANY.md \`defineCompany\` reference implementation.
 */`,
  entry: {
    index: "src/index.ts",
    "manifest/index": "src/manifest/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["zod", "gray-matter", "@agentproto/define-doctype"],
  noExternal: [],
})
