# @agentproto/voice-openai

OpenAI provider for [`@agentproto/voice`](../voice). Talks to api.openai.com
directly over HTTP and WebSocket; no agent framework is imported.

- **STT (file)**: Whisper, `POST /v1/audio/transcriptions` (multipart). The
  historical `VOICE_STT_PROVIDER=whisper` value resolves here.
- **TTS (file)**: `POST /v1/audio/speech` with `response_format: "pcm"`, raw
  PCM16 mono 24 kHz.
- **Realtime**: the GA Realtime API, `wss://api.openai.com/v1/realtime?model=...`,
  `Authorization: Bearer`, server VAD, native barge-in, function calling.
  Selected with `VOICE_PROVIDER=openai-realtime`.

`gpt-live-1.1` (Live API, `v1/live/sessions`, published 2026-11-19) is a
delegation-style voice frontend, not a drop-in Realtime session: its backend
reasoning is delegated to a Responses model instead of the host hooks, so it
does not map to the `RealtimeProvider` contract of this kit. Not implemented
in v1.

The API key is read from `OPENAI_API_KEY` and is never put in a URL or a
frame. Per-vendor defaults live in `VOICE_DEFAULTS.providers.openai`
(`@agentproto/voice`). Tests replay exchanges recorded once against the real
API (`scripts/record.mjs`) from `src/__tests__/fixtures/`; a test scans every
fixture for keys, authorization headers and account identifiers.
