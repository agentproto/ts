---
"@agentproto/runtime": patch
---

`allowPromptFrom` entries may now name callers by label: `label:<exact label>` grants a root caller session (no parent) whose operator-assigned, immutable label matches, and `label:<prefix>*` grants any such caller whose label starts with the prefix. The label (`operatorLabel`) is stamped only when the human operator spawns the session via `agent_start`, carries over `session_restart` and `session_continue_fresh`, and cannot be changed with `session_rename` or by child sessions, so the grant survives the caller restarting under a new session id without being spoofable.
