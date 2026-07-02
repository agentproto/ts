import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/adapter-mastracode-inprocess v0.1.0
 * AIP-45 proprietary protocol arm for Mastra Code, driven in-process
 * via the mastracode SDK instead of a spawned subprocess.
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["@agentproto/driver-agent-cli", "mastracode", "mastracode/headless"],
  noExternal: [],
})
