---
"sentinel": patch
---

Never orphan a sentinel when its target is an external (e.g. claude-desktop) session: park the event for inbox pull instead of attempting a revival that cannot succeed.
