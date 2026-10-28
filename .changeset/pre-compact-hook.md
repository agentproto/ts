---
"@agentproto/cli": minor
"@agentproto/harness": minor
"@agentproto/runtime": minor
---

Checkpoint before Claude Code's own compaction: `defaults.nativeHooks.preCompactCheckpoint: "on"` projects a synchronous PreCompact (auto) hook running `agentproto hook pre-compact`, which asks the daemon for a checkpoint and always exits 0.
`POST /sessions/:id/checkpoint` accepts `reason`, `occurrenceId` (deduped) and `trigger`; `reason: "native-pre-compact"` never asks the session for a handoff turn.
