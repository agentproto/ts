import { createTsupConfig } from "@agentproto/tooling/tsup/base"

const entry = {
  index: "src/index.ts",
  types: "src/types.ts",
  "creds-store": "src/creds-store.ts",
  ledger: "src/ledger.ts",
  status: "src/status.ts",
  "list-resolve": "src/list-resolve.ts",
  "mcp-tools": "src/mcp-tools.ts",
  wizard: "src/wizard.ts",
  discover: "src/discover.ts",
}

export default createTsupConfig({
  banner: `/**
 * @agentproto/adapter-kit v0.1.0-alpha
 * Generic adapter catalog, status, creds, ledger, and MCP tool primitives.
 */`,
  entry,
  format: ["esm"],
  splitting: true,
  dts: { entry },
  // Peer deps + Node builtins stay external so the kit installs them at
  // the consumer's resolution layer. zod is the only runtime value import
  // (in mcp-tools); the MCP SDK is type-only here but kept external too.
  external: [
    "@modelcontextprotocol/sdk",
    "@modelcontextprotocol/sdk/*",
    "zod",
    "node:fs",
    "node:fs/promises",
    "node:os",
    "node:path",
  ],
  noExternal: [],
})
