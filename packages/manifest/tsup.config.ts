import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/manifest v0.1.0-alpha
 * Generic verbs for AIP doctypes (create, load, list, update, resolve, …).
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: [
    "gray-matter",
    "@agentproto/define-doctype",
    "node:fs",
    "node:fs/promises",
    "node:path",
  ],
  noExternal: [],
})
