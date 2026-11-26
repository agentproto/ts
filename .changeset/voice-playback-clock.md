---
"@agentproto/voice": minor
---

Add `createPlaybackClock`, a server-side estimate of the client's playback queue (`sent`, `reset`, `queuedMs`, `waitBelow`) to pass as `CascadeOptions.playback`, so hosts no longer copy it.
