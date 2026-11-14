---
"@agentproto/adapter-browser-chrome": patch
---

chrome-live screencast: frames are stamped with Chrome's own capture timestamp (so the mp4 pacing matches capture time), and the frame buffer is also capped at about 64 MB, not only at 2000 frames.
