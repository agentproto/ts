---
name: ap-terminal
description: Open a real PTY terminal session through agentproto to drive interactive TUIs (vim, htop, an interactive CLI wizard, a nested claude TUI) with live keystrokes and byte-buffered output. Trigger phrases include "open a terminal", "start a PTY session", "type into the interactive prompt", "attach a terminal panel", "send keys to the TUI".
---

# Real PTY Terminals

## When to use

Use `ap-terminal` when a task needs a genuine interactive terminal — a TUI
that repaints in place, a CLI that prompts step by step, or anything
expecting a real tty (raw mode, cursor control, paste detection). Batch,
non-interactive work belongs in `command_execute` (see ap-run-command), not
here.

## MCP tool: terminal_start

Spawn a PTY running `argv` (e.g. `['bash']`, or an interactive CLI directly).
Set `cwd`, a `name`/`label` for the session list, and `cols`/`rows` if the
TUI is picky about terminal size.

```json
{
  "tool": "terminal_start",
  "args": {
    "argv": ["claude"],
    "cwd": "/Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/apps/simone",
    "name": "simone-claude-tui",
    "cols": 120,
    "rows": 40
  }
}
```

## MCP tool: terminal_output

Read the current screen/buffer. `clean: true` strips ANSI escape codes for
readable text; `lastBytes` caps how much of the tail you pull back. The
buffer is a ring of roughly 64KiB — older output is gone once it rolls off.

```json
{ "tool": "terminal_output", "args": { "sessionId": "term_4b91", "clean": true, "lastBytes": 4000 } }
```

## MCP tool: terminal_input

Send keystrokes. `text` is sent verbatim (no implicit newline). Set
`enter: true` to additionally send an isolated carriage return AFTER the
text — required for paste-detecting TUIs that ignore a newline embedded in
pasted content.

```json
{ "tool": "terminal_input", "args": { "sessionId": "term_4b91", "text": "/status", "enter": true } }
```

## MCP tool: terminal_kill

Tear down the PTY when done or wedged.

```json
{ "tool": "terminal_kill", "args": { "sessionId": "term_4b91" } }
```

## MCP tool: terminal_sessions_list

List live terminal sessions.

```json
{ "tool": "terminal_sessions_list", "args": {} }
```

## MCP tool: agentproto_terminal

Attach an interactive terminal panel for a human (or you) to watch or drive
live, instead of polling `terminal_output` in a loop.

```json
{ "tool": "agentproto_terminal", "args": { "sessionId": "term_4b91" } }
```

## HTTP

```
WS /sessions/:id/pty
```

Connect a raw websocket client directly to the PTY for full-duplex
streaming, bypassing the polling `terminal_output`/`terminal_input` pair.

## Gotchas

- Use for interactive TUIs (a nested claude TUI, vim, htop) — not batch
  work, which belongs in `command_execute`.
- Output is a byte ring buffer (~64KiB) — read with `clean: true` early and
  often, or scrollback that rolls off the buffer is permanently lost.
- Sending multi-line text with `enter: true`: send the content first, then
  let `enter` fire the Enter keystroke as its own isolated event — don't
  embed `\n` inside `text` for paste-sensitive prompts.
- The WS route is a lower-level escape hatch; prefer the MCP tools unless
  full-duplex streaming is genuinely required.

## Pointers

- ap-run-command — batch/synchronous commands that don't need a real tty.
- ap-spawn-agent — full agent sessions rather than a raw shell.
- agentproto — general daemon supervision skill.
