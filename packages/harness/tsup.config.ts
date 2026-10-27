import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/harness v2.15.0
 * AIP-45 AGENT-CLI.md \`defineHarness\` / \`defineAgentCli\` implementation.
 */`,
  entry: {
    index: "src/index.ts",
    "manifest/index": "src/manifest/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: [
    "zod",
    "gray-matter",
    "@agentproto/doctype",
    "@agentproto/acp",
    "node:child_process",
    "node:stream/web",
    "node:stream",
  ],
  noExternal: [],
})
