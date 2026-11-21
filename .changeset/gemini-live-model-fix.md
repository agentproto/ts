---
"@agentproto/model-catalog": patch
---

Fix the `google/gemini-live` audio catalog entry: its `providerId` pointed at `gemini-2.5-flash-preview-tts`, a TTS-only model the bidirectional Live API refuses (only `*-live-*` models take realtime audio in and out); it now carries `gemini-3.1-flash-live-preview`, the model the studio voice engine runs, and `DEFAULT_GEMINI_LIVE_MODEL` follows.
