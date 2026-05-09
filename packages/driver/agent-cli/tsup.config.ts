import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/driver-agent-cli v0.1.0-alpha
 * AIP-45 AGENT-CLI.md \`defineAgentCli\` reference implementation.
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
    "@agentproto/define-doctype",
    "@agentproto/acp",
    "node:child_process",
    "node:stream/web",
    "node:stream",
  ],
  noExternal: [],
})
