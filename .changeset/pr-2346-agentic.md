---
"@agentproto/cli": minor
"@agentproto/harness": minor
"@agentproto/runtime": minor
---

Projected PreCompact checkpoint hook: `defaults.nativeHooks.preCompactCheckpoint: "on"` gives a local claude-code session a synchronous PreCompact (auto) hook running `agentproto hook pre-compact`, which asks the daemon for a checkpoint and always exits 0. Adds the `agentproto hook pre-compact` CLI command, the `preCompactCommand` harness start option, and `reason` / `occurrenceId` / `trigger` on `POST /sessions/:id/checkpoint` (`reason: "native-pre-compact"` never asks the session for a handoff turn and repeats are deduped by `occurrenceId`).
