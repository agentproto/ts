---
"@agentproto/cli": patch
---

`agentproto hook inbox` accepts the `SessionStart` and `Stop` events. On a payload `session_id` it resolves and touches `cc:<session_id>` first, then reads that chat's inbox like `UserPromptSubmit`; `Stop` answers `{"decision":"block","reason":<inbox block>}` only for an unread `steer` item and when `stop_hook_active` is not true. Both stay silent on the legacy env fallback with no payload id. `hook install --host claude-desktop` also wires the `SessionStart` and `Stop` entries.
