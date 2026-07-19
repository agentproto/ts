---
"@agentproto/skill-pack-agentproto": patch
---

Prescribe native `agent_start({ worktree })` (daemon runs add + setup hooks) over manual `git worktree add` + `pnpm install` in the supervisor-session and durable-supervision skills, with `agentproto worktree new` as fallback
