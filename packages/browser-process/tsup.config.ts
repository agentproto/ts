import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/browser-process v0.1.0-alpha
 * Shared primitive for launching and health-waiting browser service processes.
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: [],
  noExternal: [],
})
