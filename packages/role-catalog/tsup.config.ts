import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/role-catalog v0.1.0-alpha
 * AIP-47 reference catalogue of builtin ROLE.md entries.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["@agentproto/role"],
  noExternal: [],
})
