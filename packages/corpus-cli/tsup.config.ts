import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/corpus-cli v0.1.0-alpha
 * The \`corpus\` binary — local-topology host for AIP-10 corpora.
 */`,
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    "ports/index": "src/ports/index.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: { entry: { index: "src/index.ts", "ports/index": "src/ports/index.ts" } },
  external: [
    "@agentproto/batch",
    "@agentproto/corpus",
    "@agentproto/corpus-presets",
    "@agentproto/corpus-presets/marketing",
    "gray-matter",
    "zod",
    "ajv",
    "ajv-formats",
    "node:child_process",
    "node:crypto",
    "node:fs",
    "node:fs/promises",
    "node:os",
    "node:path",
    "node:process",
    "node:url",
    "node:util",
  ],
  noExternal: [],
})
