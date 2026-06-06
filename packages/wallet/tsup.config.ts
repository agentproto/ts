import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/wallet v0.1.0-alpha
 * AIP-49 — principal-owned multi-asset wallet primitive (ERC-20 decl × ERC-1410 tranches).
 */`,
  entry: {
    index: "src/index.ts",
    "ports/index": "src/ports/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["zod", "@agentproto/define-doctype"],
  noExternal: [],
})
