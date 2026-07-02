---
"@agentproto/runtime": patch
---

Fix completion-policy gates (`policy_attach`) throwing "cwd escapes the workspace" for any session running outside the daemon's own boot-time workspace — the dominant case being a session spawned in a sibling git worktree. The gate's cwd is now trusted as the watched session's own registered cwd (already vetted at `agent_start` time) instead of being re-anchored to the daemon's single global workspace root. An explicit `gate.cwd` override is still anchored, but against that session's own cwd rather than the daemon's.
