import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/ref v0.1.0-alpha
 * agentref/v1 (AIP-27) — composable reference primitive.
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
