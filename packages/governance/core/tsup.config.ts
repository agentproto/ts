import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/governance v0.1.0-alpha
 * agentgovernance/v1 — universal contractual approval framework.
 * Vendor-neutral. Filesystem-first. Third-party verifiable.
 */`,
  entry: {
    index: "src/index.ts",
    "doctypes/index": "src/spec/doctypes/index.ts",
    "hash-chain/index": "src/spec/hash-chain/index.ts",
    "validators/index": "src/spec/validators/index.ts",
    "renderers/index": "src/spec/renderers/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: [
    "zod",
    "gray-matter",
    "yaml",
    "node:crypto",
    "node:fs",
    "node:fs/promises",
    "node:path",
  ],
  noExternal: [],
})
