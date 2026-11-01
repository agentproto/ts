---
"@agentproto/runtime": minor
---

Run a task `verify` / supervisor shell gate written as a whole shell line in `command` with no `args` (for example `grep -q x /a/b/RAPPORT.md`) as `bash -c <line>` instead of allowlist-checking `basename()` of the whole string. The allowlist now applies to `bash`, and refusals name the command actually checked plus the original line; the structured `{command, args}` form is unchanged. Also exports `resolveShellGateExec`, `describeGateRefusal`, and `ResolvedShellGateExec` from the `./command-allowlist` subpath, hence a minor bump.
