---
"@agentproto/runtime": minor
---

A task `verify` gate or supervisor shell gate written as a whole shell line in `command` with no `args` (for example `grep -q x /a/b/RAPPORT.md`) is now run as `bash -c <line>` instead of being allowlist-checked by `basename()` of the whole string, which refused it with a misleading `command 'RAPPORT.md' not in allowlist`. A relative `command` that exists in the gate's cwd stays a plain command. The allowlist now applies to `bash` (honouring any argv constraint on a `bash` entry), and the refusal names the command actually checked plus the original line. The structured `{command, args}` form is unchanged. Adds the exports `resolveShellGateExec`, `isShellGateExecAllowed`, `describeGateRefusal` and `ResolvedShellGateExec` to `command-allowlist`.
