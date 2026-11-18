---
"@agentproto/runtime": minor
---

Label addressing policy: `defaults.messaging.labelAddressing` (`open` | `tree` | `operator`, default `tree`) and per-session `agent_start.labelAddressing`. Under `tree` (default) a `label` a supervisor gives a child at `agent_start` becomes a protected family name: `message_send to:"label:<x>"` (and the drive tools) resolve it only for the parent and the child's siblings, it is unique in the family, and only the parent can set it. `open` lets any session address any label; `operator` keeps the previous behaviour (only operator/owner-stamped labels, resolved for everyone). Operator-stamped root labels are unchanged in every mode.
