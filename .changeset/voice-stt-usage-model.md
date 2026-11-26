---
"@agentproto/voice": minor
"@agentproto/voice-elevenlabs": minor
"@agentproto/voice-openai": minor
"@agentproto/voice-assemblyai": minor
---

STT usage entries now carry the vendor model that transcribed the utterance. `SttProvider` gains an optional `models: { stream?, file? }` (the realtime stream and file transcription run different models) and the cascade copies the one that produced each utterance onto the usage entry, as it already does for TTS. The ElevenLabs, OpenAI and AssemblyAI providers report theirs.
