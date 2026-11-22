---
"@agentproto/voice": minor
---

Voice kit: new voice settings in `@agentproto/voice` defaults. Turn-level TTS mode (`ttsMode`, default `http-sentence`, `VOICE_TTS_MODE` spellings accepted via `ttsModeFromEnv`) and per-sentence transport (`ttsTransport`, streaming by default, `http` opt-out via `ttsTransportFromEnv`). Session mic-idle close (`idleMicMs`, default 60 s, 0 disables, `hooks.onMicIdle` notified). Three-guard STT dedup (`sttDedup`, on by default: duplicate transcripts within 5 s, assistant echo within 10 s at 60 % token overlap; `false` disables). PCM16 even-chunk alignment guarantee (`Pcm16ChunkAligner`, applied to every emitted audio frame). Data-only defaults for a future WebRTC/Opus transport and the per-vendor billing model ids. All existing tests stay green; defaults change, no existing value changes meaning.
