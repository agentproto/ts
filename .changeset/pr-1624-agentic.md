---
"@agentproto/apps": patch
---

Fix the session-steward agent judge lane: the `judgeOne` step forced `cwd: tmpdir()`, which lies outside the app boundary's readable zones, so every agent judge spawn was refused (`app_boundary_cwd_outside`) and judged candidates silently fell back to verdict `active`. Dropping the explicit `cwd` lets the agent host fall back to the run cwd (the app root), which is inside the boundary.
