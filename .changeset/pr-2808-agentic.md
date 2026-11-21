---
"@agentproto/voice": patch
"@agentproto/voice-gemini": minor
---

Add `@agentproto/voice-gemini`, a Gemini Live (BidiGenerateContent) realtime provider for `@agentproto/voice`: one WebSocket per session, a single setup frame (bidi model, AUDIO responses, voice, both transcriptions, JSON-Schema tool declarations), base64 PCM16 input with `activityEnd` commits, tool-call round trips, interrupted-turn handling and usage mapping. `refreshTools()` reconnects with a fresh setup because the Live wire freezes tools at setup.

Update the `gemini` provider defaults comment in `@agentproto/voice` to record that the model catalog's `google/gemini-live` entry now carries the same bidi Live model id.
