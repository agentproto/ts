---
"@agentproto/runtime": patch
---

Fix chrome-live screencast mp4 pacing: each frame is now shown for the gap to the NEXT frame instead of the gap behind it, which shifted every frame one slot late and flashed the first frame for 0.05s.
