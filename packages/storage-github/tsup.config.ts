import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/storage-github v0.1.0-alpha
 * AIP-35 github WorkspaceSync provider.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["@agentproto/storage", "@octokit/rest"],
  noExternal: [],
})
