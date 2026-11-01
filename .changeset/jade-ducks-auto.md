---
"@agentproto/runtime": minor
---

A task `verify` gate or supervisor shell gate written as a whole shell line in `command` with no `args` (for example `grep -q x /a/b/RAPPORT.md`) is now run as `bash -c <line>` instead of being allowlist-checked by `basename()` of the whole string, which refused it with a misleading `command 'RAPPORT.md' not in allowlist`. The allowlist now applies to `bash`, and the refusal names the command actually checked plus the original line. The structured `{command, args}` form is unchanged.
