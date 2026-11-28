import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/collect-cli
 * The \`collect\` binary: a command-line tool for collecting public posts and articles with provenance.
 */`,
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: { entry: { index: "src/index.ts" } },
  external: ["@agentproto/collect", "@agentproto/collect/node", "yaml", "zod", /^node:/],
  noExternal: [],
})
