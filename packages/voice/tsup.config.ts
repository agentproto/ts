import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/voice
 * AIP-VOICE VOICE: provider contracts, registry, VoiceSession with realtime and cascade engines.
 */`,
  entry: {
    index: "src/index.ts",
    defaults: "src/defaults.ts",
    testing: "src/testing/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: [],
  noExternal: [],
})
