---
"@agentproto/runtime": patch
---

Allow at most one continue-fresh per source session: a duplicate or concurrent call with the same options now returns the first call's checkpoint and successor instead of spawning a second one, while a later call with different options is refused with `already_continued` rather than silently returning the first successor.
