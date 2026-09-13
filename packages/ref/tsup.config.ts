import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/ref v0.1.0-alpha
 * AIP-54 REF reference implementation (absorbing AIP-27's world scheme).
 */`,
  entry: {
    index: "src/index.ts",
    "kinds/index": "src/kinds/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["zod"],
  noExternal: [],
})
