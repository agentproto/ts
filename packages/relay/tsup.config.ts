import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/relay v0.1.0-alpha
 * Standalone webhook-to-session relay: one fixed target session, one bearer token.
 */`,
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: [
    "ws",
    "node:http",
    "node:crypto",
    "node:fs/promises",
    "node:os",
    "node:path",
    "node:url",
  ],
  noExternal: [],
})
