---
name: ap-run-command
description: Run a short, allowlisted shell command on the host synchronously through the agentproto daemon and get stdout/stderr/exit code back as a trackable command session. Trigger phrases include "run this command", "execute pnpm test", "check the command allowlist", "tail the command log", "list recent commands run".
---

# Run a Command

## When to use

Use `ap-run-command` for SHORT, synchronous, non-interactive shell work — a
lint check, a single test file, a git status, a quick build step. It is not
for long builds/test suites (use a session or a background terminal instead,
see ap-terminal) and not for interactive TUIs.

## MCP tool: command_execute

`command` must be a bare basename allowlisted in
`<workspace>/.agentproto/allowed-commands.json`. `args` is an array passed to
the process verbatim — there is NO shell expansion, so no pipes, globs,
`&&`, or quoting tricks. `timeoutMs` caps at 600000 (10 minutes). `stdin` can
feed input; `cwd` sets the working directory.

```json
{
  "tool": "command_execute",
  "args": {
    "command": "pnpm",
    "args": ["--filter=@simone/core", "check-types"],
    "cwd": "/Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio",
    "timeoutMs": 120000
  }
}
```

Every invocation creates a `kind: 'command'` session you can read back later
like any other session.

## MCP tool: command_list

List recent command sessions, newest first.

```json
{ "tool": "command_list", "args": { "limit": 20 } }
```

## MCP tool: command_log_tail

Tail the stdout/stderr of a specific command session, e.g. while it's still
running.

```json
{ "tool": "command_log_tail", "args": { "sessionId": "cmd_7f0a", "lines": 200 } }
```

## MCP tool: tool_calls_list

Unified log across both `command_execute` calls and agent tool calls — audit
what actually ran, in order, across a session or the whole workspace.

```json
{ "tool": "tool_calls_list", "args": { "sessionId": "sess_a1b2" } }
```

## HTTP

None — `command_execute` and friends are MCP/CLI-only; there is no daemon
HTTP route for one-off command execution.

## Gotchas

- Only for SHORT synchronous commands — a 10-minute `command_execute` call
  blocks your turn; long builds/tests belong in a session (ap-spawn-agent) or
  a background terminal (ap-terminal).
- No shell expansion: no pipes, no globs, no `&&`, no shell-interpreted
  quoting. Pre-compute the expansion yourself or wrap the logic in a script
  file and call that script instead.
- `command` must match an allowlisted basename exactly — a full path or an
  unlisted binary is rejected before it runs.
- Every command run is itself a readable session — use `command_log_tail` or
  `conversation_read` instead of re-running to see output you missed.

## Pointers

- ap-terminal — interactive or long-running work that doesn't fit
  command_execute's model.
- ap-spawn-agent — hand off multi-step or long-running work to a full agent
  session instead.
- extend-agentproto — adding a new binary to the allowlist.
