import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/voice-openai
 * OpenAI provider for @agentproto/voice: Whisper STT, speech TTS, Realtime API.
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: [],
  noExternal: [],
})
