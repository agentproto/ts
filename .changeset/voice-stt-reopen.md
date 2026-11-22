---
"@agentproto/voice": patch
---

Reopen the realtime transcription stream when it drops after a turn, instead of staying on file transcription (about 0.3 to 0.6 s slower per turn) for the rest of the call. A failed reopen is retried with a backoff and gives up after three attempts, falling back to file transcription as before.
