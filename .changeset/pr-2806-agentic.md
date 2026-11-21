---
"@agentproto/voice": minor
"@agentproto/voice-openai": minor
---

Add `@agentproto/voice-openai`, the OpenAI voice provider: Whisper file-based STT, HTTP TTS, and a GA Realtime WebSocket session (audio in/out, barge-in interruption, function-calling, usage metering). The provider registers under `openai` with a `whisper` STT value alias, ships recorded wire fixtures that the test suite secret-scans, and is declared in the `voice` registry's provider catalog.

Also fix the voice cascade pipeline's `onTurnEnd` precedence: it no longer fires after `close()`, even when the turn ended voluntarily.
