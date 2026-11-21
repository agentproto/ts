# @agentproto/voice-gemini

Google Gemini provider for [`@agentproto/voice`](../voice). Talks to
`generativelanguage.googleapis.com` directly over WebSocket; no agent
framework is imported.

- **Realtime (Live)**: the bidirectional Live API,
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`,
  selected with `VOICE_PROVIDER=gemini-live`. One WebSocket per session, one
  `setup` message (model under `models/`, AUDIO response modalities, the
  prebuilt voice from the defaults, input and output audio transcription,
  tool declarations), audio in as base64 PCM16 (`audio/pcm;rate=<n>`),
  `activityEnd` as the reply commit (the API runs with its automatic VAD off,
  like the studio adapter), transcripts out on both sides, `turnComplete` as
  the end of turn, and `usageMetadata` mapped onto the kit's token buckets
  (undifferentiated counts, so they land in the text buckets).
- **Interruption**: the Live wire has no client-side cancel; `interrupt()`
  cuts playback client-side (one `interrupt`, no audio after it) and the next
  reply starts from the next `commit()`. The server's own cut
  (`serverContent.interrupted`) maps to the same event.
- **Tools are frozen at setup** on this wire (no session.update):
  `refreshTools()` reconnects the session with a fresh setup, mirroring the
  studio adapter.
- **STT / TTS**: not implemented; the kit composes them from the other
  providers (Whisper, ElevenLabs, AssemblyAI).

The API key is read from `GEMINI_API_KEY` (else `GOOGLE_API_KEY`, the
`@google/genai` convention) and travels only in the WebSocket URL query; it
never appears in a frame. Per-vendor defaults live in
`VOICE_DEFAULTS.providers.gemini` (`@agentproto/voice`).

Tests run on **scripted protocol frames**, written from the wire the studio
runs in production (no recorded fixtures: the only Google API key on this
machine answers 403 PERMISSION_DENIED, a billing-account issue only an
operator can lift). `scripts/record.mjs` turns the scripted frames into real
recordings once the account accepts requests again; see the comment at the
top of `src/__tests__/gemini.test.ts`.
