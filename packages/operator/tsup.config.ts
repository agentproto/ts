import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/operator v0.1.0-alpha
 * AIP-9 OPERATOR.md \`defineOperator\` reference implementation.
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
