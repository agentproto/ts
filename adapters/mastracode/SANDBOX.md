# Mastra Code — Sandbox

Mastra Code is a terminal-based AI coding agent. Its sandbox policy
is governed by the user's configuration:

- **Allowed paths**: Configured via `/sandbox` slash command or
  `settings.json`. By default the project root is the sandbox boundary.
- **Permissions mode**: `auto` (approve all tools) or `deny`
  (refuse all). Toggled with `/yolo` in TUI mode. In headless mode
  controlled by `--permission-mode`.
- **Shell access**: Available within allowed paths. Shell output
  appears as `shell_output` events in JSONL mode.

## Headless mode

When invoked with `--prompt --output jsonl`, Mastra Code runs as
a non-interactive JSONL stream suitable for programmatic consumption.
The agent's actual tool execution is governed by the configured
permission mode — `auto` (default in headless) auto-approves all
tool calls.

## ACP module

Mastra Code exports `mastracode/acp` as an ACP-compatible agent
module (`MastraCodeAcpAgent` implementing the `Agent` interface from
`@agentclientprotocol/sdk`). A CLI subcommand `mastracode acp` is
not yet shipped but the module is importable for custom wrappers.
