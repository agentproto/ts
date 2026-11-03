import { createTsupConfig } from "@agentproto/tooling/tsup/base"

/**
 * Two standalone bundles: the library (`dist/index.mjs`, imported by
 * relative path from workflow entries and repo scripts) and the
 * `agentproto-git-cas` CLI (`dist/cli.mjs`). Splitting is OFF so each
 * file runs on its own.
 */
export default createTsupConfig({
  banner: `/**
 * @agentproto/git-cas
 * Compare-and-swap git push with a typed outcome.
 */`,
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: ["node:child_process", "node:util"],
  noExternal: [],
})
