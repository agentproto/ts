---
"@agentproto/cli": minor
"@agentproto/apps": minor
---

Steward becomes an attention tool: `agentproto steward` now runs the new
read-only `session-attention` workflow by default — every live session gets a
verdict aimed at the human (needs-reply, stuck, blocked, done, superseded,
parked, active), a one-line reason, its real title and a last-message excerpt,
ordered most-urgent-first, with a plain-text digest capped for chat delivery.
Loop and errored-turn detection now also run on idle sessions, and an idle
session is never reported as active. The old close/flag behaviour moves behind
`--wrapup`; `--apply`, `--min-confidence` and `--ask-sessions` without it are an
error. New flags: `--include-children`, `--format <markdown|text>`.
