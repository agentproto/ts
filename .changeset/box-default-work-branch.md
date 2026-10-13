---
"@agentproto/runtime": minor
---

Box (sandbox) sessions on a workspace with a remote now get a `wt/<slug>` work branch by default (`worktree: false` opts out), so they always have a delivery target recorded on the session. At each turn end the checkpoint hook adopts a different `wt/` branch the agent moved to as the delivery target. `session_restart` on a dead box now restarts on a fresh box from the workspace's base branch when no work branch was recorded, and when it truly cannot proceed the error says why and points at `agentproto workspace remote set <slug> --url … --token-stdin`.
