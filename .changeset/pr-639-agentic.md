---
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

Implement idle agent-session reaper (PR-6): periodically retire long-idle agent-cli sessions to free adapter processes and prevent resume-storms on daemon restart. New public API exports `runIdleReapPass`, `IdleReapSummary`, and `IdleReaperRegistry` for library users; opt-in via `daemon.idleReapAfterMs` config field or `AGENTPROTO_IDLE_REAP_AFTER_MS` env var.
