---
"@agentproto/runtime": minor
---

Worktree spawns now default to async provisioning, and label+cwd worktree collisions are refused instead of warned about. Provisioning spawns return immediately with status `"starting"` (resolved `cwd` backfilled when ready); `worktree: { async: false }` restores the old blocking contract, and `wait: true` falls back to the synchronous path by default (explicit `wait` + `async: true` remains rejected). A spawn landing in a worktree already occupied by a live session under the same label is refused — the sync path returns the existing session's descriptor (`dedupeSource: "worktree-cwd"`), the async path settles as a readable error — instead of forking a second live agent. `dedupeSource` gains the new `"worktree-cwd"` value.
