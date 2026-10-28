---
"@agentproto/runtime": minor
---

Follow agent-caused mode changes in the session posture. An AIP-45 `mode-changed` with `cause: "agent"` now updates the descriptor's `posture` (canonical when the mode id maps through the alias table, else `{ harnessModeId }`) and emits `session:config-changed {axis: "posture"}`. Caller echoes are not re-applied. The descriptor gains `postureSource` and `postureCeiling`: an agent move past the caller's posture is recorded, warned via `session:harness-warning`, and a restart clamps back to the caller's posture; otherwise a restart starts in the current posture.
