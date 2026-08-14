---
"@agentproto/runtime": patch
---

Fix shutdown persistence race and failed spawn signal bug. Prevents child process exit handlers from re-arming persistence timers after shutdown (which would wipe session history to disk), and stops accidental SIGTERM signaling to the daemon's own process group when a spawn fails.
