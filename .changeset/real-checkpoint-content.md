---
"@agentproto/runtime": minor
---

feat(runtime): context checkpoints now carry real content instead of "(… captured in recent digest)" placeholders. `goal` is the session's initial prompt; `tests` comes from the last completion-policy gate (new `lastGate.command`) or the last test-like tool call; `nextStep` from the session's open tasks or last agent message; `errors` from the last `[error]`; `plan` from the last plan notice. `decisions`, `risks` and a better `nextStep` come from an optional handoff turn to the live idle source session (zod-validated JSON, 60s timeout, falls back to extraction; `askSource: false` disables it). `session_checkpoint` and `session_continue_fresh` accept `notes` and `askSource`. Checkpoints gain `schemaVersion: 1`, a `handoffTurn` status, and a published JSON Schema at `@agentproto/runtime/schemas/checkpoint.v1.json`.
