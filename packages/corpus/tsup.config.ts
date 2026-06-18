import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/corpus v0.1.0-alpha
 * Composition of AIP-10/12/18/9/15/41 — autonomous knowledge-improvement kit.
 */`,
  entry: {
    index: "src/index.ts",
    "ports/index": "src/ports/index.ts",
    "report/index": "src/report/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: [
    "zod",
    "gray-matter",
    "yaml",
    "ajv",
    "ajv-formats",
    "@agentproto/knowledge",
    "@agentproto/collection",
    "@agentproto/playbook",
    "@agentproto/operator",
    "@agentproto/workflow",
    "@agentproto/routine",
  ],
  noExternal: [],
})
