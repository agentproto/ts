---
"@agentproto/runtime": patch
---

Wire the `agentproto:session-completed` host event: a pure derivation helper for the terminal-transition occurrence (`exit:<endedAt>`), a bounded in-process emitter wired to `session:exited` and `policy:passed`, and the corresponding bus event type. The PR already ships `.changeset/action-hooks-session-completed.md` with the same package and bump; this file is redundant and CI may drop it. Once completions recorded after the exit event (steward close, `session_mark_completed`, operator "Mark as completed") are emitted too, revisit whether the new host-event contract warrants a `minor` bump.
