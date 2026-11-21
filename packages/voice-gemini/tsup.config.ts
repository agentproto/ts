import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/voice-gemini
 * Google Gemini Live provider for @agentproto/voice: speech-to-speech over the Live API.
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: [],
  noExternal: [],
})
