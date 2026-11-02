---
"@agentproto/cli": minor
---

`agentproto hook inbox` accepts `Stop` and `SessionStart`. As a `Stop` hook it answers `{"decision":"block","reason":<inbox block>}` only when an unread `steer` (must-wake) item is in the inbox and the payload's `stop_hook_active` is not true, otherwise it prints nothing and acks nothing; as a `SessionStart` hook it injects the unread inbox as `additionalContext`, like `UserPromptSubmit`. `agentproto hook install --host claude-desktop` now also installs the `SessionStart` and `Stop` entries (idempotent, other keys kept).
