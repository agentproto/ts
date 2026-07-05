import { createTsupConfig } from "@agentproto/tooling/tsup/base"

const entry = {
  index: "src/index.ts",
  types: "src/types.ts",
  "creds-store": "src/creds-store.ts",
  ledger: "src/ledger.ts",
  "list-resolve": "src/list-resolve.ts",
  "mcp-tools": "src/mcp-tools.ts",
  wizard: "src/wizard.ts",
  discover: "src/discover.ts",
}

export default createTsupConfig({
  banner: `/**
 * @agentproto/adapter-kit v0.2.0 (deprecated shim)
 * Re-exports @agentproto/provider-kit unchanged.
 */`,
  entry,
  format: ["esm"],
  splitting: true,
  dts: { entry },
  external: ["@agentproto/provider-kit", "@agentproto/provider-kit/*"],
  noExternal: [],
})
