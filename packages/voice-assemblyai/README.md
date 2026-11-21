# @agentproto/voice-assemblyai

AssemblyAI provider for [`@agentproto/voice`](../voice). Talks to AssemblyAI
directly over WebSocket and HTTP; no agent framework is imported.

- **STT streaming**: Universal Streaming v3, `wss://streaming.assemblyai.com/v3/ws`
  (binary PCM16 frames up, `Turn` messages down, `ForceEndpoint` for a final
  on demand, `Terminate` to end).
- **STT file**: `POST /v2/upload` then `POST /v2/transcript` (polled).
- **TTS streaming**: TTS-1 over `wss://tts.us.assemblyai.com/v1/ws`
  (`Generate` / `Flush` / `Cancel` / `Terminate` up, `Audio` / `FlushDone` /
  `Termination` down), PCM16 mono, 8-48 kHz.
- **TTS file**: `POST https://tts.us.assemblyai.com/v1/speech`, raw PCM body.

AssemblyAI has no hosted speech-to-speech agent, so this provider declares
the `stt` and `tts` stages only; a realtime engine composes them through the
cascade of `@agentproto/voice`.

The API key is read from `ASSEMBLYAI_API_KEY` (header `Authorization`) and is
never put in a URL or a frame. Protocol values were read from
assemblyai.com/docs on 2026-11-21; the per-vendor defaults live in
`VOICE_DEFAULTS.providers.assemblyai` (`@agentproto/voice`).

Tests replay exchanges recorded once against the real API
(`scripts/record.mjs`, a few cents) from `src/__tests__/fixtures/`; a test
scans every fixture for keys, authorization headers and account identifiers.
