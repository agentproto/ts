# @agentproto/voice

## 0.1.0

### Minor Changes

- 1bd0a31: Add `@agentproto/voice-openai`, the OpenAI voice provider: Whisper file-based STT, HTTP TTS, and a GA Realtime WebSocket session (audio in/out, barge-in interruption, function-calling, usage metering). The provider registers under `openai` with a `whisper` STT value alias, ships recorded wire fixtures that the test suite secret-scans, and is declared in the `voice` registry's provider catalog.

  Also fix the voice cascade pipeline's `onTurnEnd` precedence: it no longer fires after `close()`, even when the turn ended voluntarily.

  `@agentproto/voice` becomes publishable (drops `"private": true`), so this release is its first publish (0.0.0 to 0.1.0).

- 5b792bc: Voice kit: new voice settings in `@agentproto/voice` defaults. Turn-level TTS mode (`ttsMode`, default `http-sentence`, `VOICE_TTS_MODE` spellings accepted via `ttsModeFromEnv`) and per-sentence transport (`ttsTransport`, streaming by default, `http` opt-out via `ttsTransportFromEnv`). Session mic-idle close (`idleMicMs`, default 60 s, 0 disables, `hooks.onMicIdle` notified). Three-guard STT dedup (`sttDedup`, on by default: duplicate transcripts within 5 s, assistant echo within 10 s at 60 % token overlap; `false` disables). PCM16 even-chunk alignment guarantee (`Pcm16ChunkAligner`, applied to every emitted audio frame). Data-only defaults for a future WebRTC/Opus transport and the per-vendor billing model ids. All existing tests stay green; defaults change, no existing value changes meaning.

### Patch Changes

- fdb4d55: Add `@agentproto/voice-gemini`, a Gemini Live (BidiGenerateContent) realtime provider for `@agentproto/voice`: one WebSocket per session, a single setup frame (bidi model, AUDIO responses, voice, both transcriptions, JSON-Schema tool declarations), base64 PCM16 input with `activityEnd` commits, tool-call round trips, interrupted-turn handling and usage mapping. `refreshTools()` reconnects with a fresh setup because the Live wire freezes tools at setup.

  Update the `gemini` provider defaults comment in `@agentproto/voice` to record that the model catalog's `google/gemini-live` entry now carries the same bidi Live model id.

- 81b8e59: Reopen the realtime transcription stream when it drops after a turn, instead of staying on file transcription (about 0.3 to 0.6 s slower per turn) for the rest of the call. A failed reopen is retried with a backoff and gives up after three attempts, falling back to file transcription as before.
- 23a5c2c: The TTS usage entry now carries the vendor model that ran. `TtsProvider` gets an optional `model`, the cascade passes it to the usage meter (which already accepted one but was never given it), and the ElevenLabs and OpenAI providers report theirs. Without it a host could only guess which model to price the characters against.
- Updated dependencies [765660d]
- Updated dependencies [1741e68]
- Updated dependencies [89258dd]
  - @agentproto/provider-kit@0.7.0
