import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/agencies v0.1.0-alpha
 * agentagencies/v1 — operating layer for entities that exercise agency.
 * Vendor-neutral. Filesystem-first. Extends agentcompanies/v1 + agentgovernance/v1.
 */`,
  entry: {
    index: "src/index.ts",
    "doctypes/index": "src/spec/doctypes/index.ts",
    "validators/index": "src/spec/validators/index.ts",
    "composition/index": "src/spec/composition/index.ts",
    "renderers/index": "src/spec/renderers/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: [
    "zod",
    "gray-matter",
    "yaml",
    "@agentproto/governance",
    "node:crypto",
    "node:fs",
    "node:fs/promises",
    "node:path",
  ],
  noExternal: [],
})
