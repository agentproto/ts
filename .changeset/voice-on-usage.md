---
"@agentproto/voice": minor
---

Add `VoiceStartOptions.onUsage`: the final usage record is handed to the host once when a cascade or realtime session closes (same content as `getUsage()` after `close()`). A throwing or rejecting sink is swallowed and never affects the session.
