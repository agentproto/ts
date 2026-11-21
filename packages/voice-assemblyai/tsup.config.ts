import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/voice-assemblyai
 * AssemblyAI provider for @agentproto/voice: streaming STT (v3) and TTS-1.
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: [],
  noExternal: [],
})
