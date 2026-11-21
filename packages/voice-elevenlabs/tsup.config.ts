import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/voice-elevenlabs
 * ElevenLabs provider for @agentproto/voice: TTS, Scribe STT, hosted agent.
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: [],
  noExternal: [],
})
