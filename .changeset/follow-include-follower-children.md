---
"@agentproto/runtime": patch
---

session_follow: `excludeFollowerChildren: false` now actually delivers the follower's own descendants (any depth) under a broad selector, bypassing `rootOnly`/`cwdPrefix`. Before, a supervisor following `all` (rootOnly by default) still missed every child it spawned.
