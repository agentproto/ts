# @agentproto/voice-gemini

## 0.1.0

### Minor Changes

- fdb4d55: Add `@agentproto/voice-gemini`, a Gemini Live (BidiGenerateContent) realtime provider for `@agentproto/voice`: one WebSocket per session, a single setup frame (bidi model, AUDIO responses, voice, both transcriptions, JSON-Schema tool declarations), base64 PCM16 input with `activityEnd` commits, tool-call round trips, interrupted-turn handling and usage mapping. `refreshTools()` reconnects with a fresh setup because the Live wire freezes tools at setup.

  Update the `gemini` provider defaults comment in `@agentproto/voice` to record that the model catalog's `google/gemini-live` entry now carries the same bidi Live model id.

### Patch Changes

- Updated dependencies [1bd0a31]
- Updated dependencies [fdb4d55]
  - @agentproto/voice@0.1.0
