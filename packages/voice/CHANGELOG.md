# @agentproto/voice

## 0.1.0

### Minor Changes

- 1bd0a31: Add `@agentproto/voice-openai`, the OpenAI voice provider: Whisper file-based STT, HTTP TTS, and a GA Realtime WebSocket session (audio in/out, barge-in interruption, function-calling, usage metering). The provider registers under `openai` with a `whisper` STT value alias, ships recorded wire fixtures that the test suite secret-scans, and is declared in the `voice` registry's provider catalog.

  Also fix the voice cascade pipeline's `onTurnEnd` precedence: it no longer fires after `close()`, even when the turn ended voluntarily.

  `@agentproto/voice` becomes publishable (drops `"private": true`), so this release is its first publish (0.0.0 to 0.1.0).

### Patch Changes

- fdb4d55: Add `@agentproto/voice-gemini`, a Gemini Live (BidiGenerateContent) realtime provider for `@agentproto/voice`: one WebSocket per session, a single setup frame (bidi model, AUDIO responses, voice, both transcriptions, JSON-Schema tool declarations), base64 PCM16 input with `activityEnd` commits, tool-call round trips, interrupted-turn handling and usage mapping. `refreshTools()` reconnects with a fresh setup because the Live wire freezes tools at setup.

  Update the `gemini` provider defaults comment in `@agentproto/voice` to record that the model catalog's `google/gemini-live` entry now carries the same bidi Live model id.

- Updated dependencies [765660d]
- Updated dependencies [1741e68]
- Updated dependencies [89258dd]
  - @agentproto/provider-kit@0.7.0
