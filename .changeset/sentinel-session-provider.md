---
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

Add a built-in `session` sentinel provider (AIP-60): `sentinel_watch { subject: "session:<id>" }` now watches another session's own lifecycle — turn-end, awaiting-input, exit — and lands matching events into the caller's inbox even if the watched session never calls `message_parent`, self-expiring once it exits (`until` defaults to `subject_terminal` for this subject scheme). `agentproto sentinel watch session:<id>` and its CLI usage text gain the same capability.
