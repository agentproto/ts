---
"@agentproto/voice": patch
"@agentproto/voice-elevenlabs": patch
"@agentproto/voice-openai": patch
---
The TTS usage entry now carries the vendor model that ran. `TtsProvider` gets an optional `model`, the cascade passes it to the usage meter (which already accepted one but was never given it), and the ElevenLabs and OpenAI providers report theirs. Without it a host could only guess which model to price the characters against.
