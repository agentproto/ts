# session_command_self

Run a harness slash-command on **yourself** (`/compact`, `/clear`,
`/model <id>`, ...). A session can't type into itself and can't compact in the
middle of a turn, so the daemon **queues** the command on your own prompt queue;
it runs when your current turn **ends**, as if the operator had typed it (the
text goes verbatim as the first block of the next prompt, which is what the
harness's own dispatcher needs).

```jsonc
{ "tool": "session_command_self", "arguments": { "command": "compact" } }
{ "tool": "session_command_self", "arguments": { "command": "model", "args": "claude-fable-5-2" } }
```

## Policy

1. **Adapter allow-list**: the adapter manifest declares
   `capabilities.selfCommands` (bare names). Anything else is refused with the
   allowed list (`command_not_allowed`); a harness with no list refuses all
   (`no_self_commands`). For ACP agents configured by hand: `acpAgents.<slug>.self_commands`.
2. **Live availability**: when the harness advertised commands
   (`session_commands`), the command must be in that list (`command_not_available`).
3. **Session policy**: `contextContinuity.compactRequiresOperator` still
   refuses a self-compaction (the operator's agreement is part of that policy).
4. Args: one line, at most 500 characters, no newline (a second command can't be smuggled in).

`compact` is spelled `compress` on hermes; asking for either works.

## Allow-list per harness

The effective set is *allow-list ∩ what the installed harness advertises*.

| harness | allowed self-commands |
| --- | --- |
| claude-code | `compact`, `clear`, `model`, `context`, `cost`, `status` |
| codex | `compact`, `new`, `status`, `model` |
| opencode | `compact`, `summarize`, `new`, `models` |
| copilot-cli | `compact`, `clear`, `model`, `context`, `usage` |
| mistral-vibe | `compact`, `clear` |
| hermes | `compress`, `new`, `reset`, `model`, `usage` |

Other harnesses declare none until their adapter lists some.
