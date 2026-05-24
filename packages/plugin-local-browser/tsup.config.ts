import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/plugin-local-browser v0.1.0-alpha
 * Bridge a real local Chrome profile into the agentproto daemon as
 * a proxied MCP server. CLI: \`agentproto-browser setup\`.
 */`,
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: { entry: { index: "src/index.ts" } },
  external: [
    "node:url",
    "node:path",
    "node:fs",
    "node:fs/promises",
    "node:os",
    "node:readline/promises",
    "node:process",
    "node:child_process",
  ],
  noExternal: [],
})
