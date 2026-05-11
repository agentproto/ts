import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/cli v0.1.0-alpha
 * The \`agentproto\` binary — install / run / serve AIP-45 agent CLIs.
 */`,
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: { entry: { index: "src/index.ts" } },
  external: [
    "@agentproto/acp",
    "@agentproto/driver-agent-cli",
    // Third-party deps — externalised so the published cli installs
    // them via npm at runtime. `gray-matter` is CJS + does dynamic
    // require("fs"), which esbuild can't safely inline into an ESM
    // bundle, so it MUST stay external. zod + @modelcontextprotocol/sdk
    // are also external because they're already on npm and bundling
    // them would just bloat the cli without benefit.
    "@modelcontextprotocol/sdk",
    "@modelcontextprotocol/sdk/*",
    "gray-matter",
    "zod",
    "ws",
    "node:child_process",
    "node:fs",
    "node:fs/promises",
    "node:os",
    "node:path",
    "node:process",
    "node:url",
    "node:util",
  ],
  // Workspace @agentproto/* packages NOT yet on npm — bundle them
  // into cli.mjs. Once each lands on npm independently, move it to
  // `external` and declare it under `dependencies` in package.json.
  noExternal: [
    "@agentproto/runtime",
    "@agentproto/agent",
    "@agentproto/manifest",
    "@agentproto/mcp-server",
    "@agentproto/extension",
    "@agentproto/define-doctype",
  ],
})
