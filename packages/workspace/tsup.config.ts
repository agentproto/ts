import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/workspace v0.1.0-alpha
 * AIP-34 WORKSPACE.md \`defineWorkspace\` reference implementation.
 */`,
  entry: {
    index: "src/index.ts",
    "manifest/index": "src/manifest/index.ts",
    "checker/index": "src/checker/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["zod", "gray-matter", "yaml", "@agentproto/doctype", "@agentproto/work", "@agentproto/work/manifest"],
  noExternal: [],
})
