# `agentproto chat` / `agentproto chat-tui`

```text
agentproto chat      <adapter> [--model <id>] [--cwd <dir>] [--workspace <slug>]
                                [--label <text>] [--keep] [--no-color]
agentproto chat-tui  <adapter> [--model <id>] [--cwd <dir>] [--workspace <slug>]
                                [--label <text>] [--system <text>] [--keep]
```

Interactive, multi-turn REPL on top of a daemon-hosted agent session.

Where [`run`](./run.md) is one-shot (pipe a prompt, get a stream, exit)
and [`sessions --attach`](./sessions.md) is read-only output, `chat` is
the human loop: type a line → watch the agent's reply stream back (text,
`[tool]` calls, thoughts, `turn-end`) → type again.

`chat` interleaves a readline prompt with raw stream lines.
`chat-tui` renders a split-pane TUI (Ink/React) with scrolling styled
history, a "thinking…" spinner, dimmed `[tool]` lines, and a bottom
input box that is disabled during in-flight turns.

Requires a running daemon ([`serve.md`](./serve.md)). The session is
spawned fresh and killed on exit (`/exit`, `/quit`, or Ctrl-C). Pass
`--keep` to leave it alive for later `sessions --attach`.

## Flags (chat)

| Flag | Default | Description |
|------|---------|-------------|
| `--model <id>` | adapter default | Model id (`provider/model`). |
| `--cwd <dir>` | `process.cwd()` | Working directory for the session. |
| `--workspace <slug>` | — | Registered workspace to bind to. |
| `--label <text>` | `"chat"` | UI label for the session. |
| `--keep` | `false` | Don't kill the session on exit. |
| `--no-color` | `false` | Strip ANSI from output. |

## Flags (chat-tui)

All `chat` flags plus:

| Flag | Default | Description |
|------|---------|-------------|
| `--system <text>` | built-in CLI formatting prompt | System prompt injected as a silent first turn. Pass `""` to disable. |

The default system prompt instructs the model to use clean terminal
markdown (headings, bullets, code spans, fenced blocks) and to avoid
`**`\``code`\``**` patterns.

## Prompt delivery

Each line you type POSTs to `/sessions/:id/prompt`. If the session
died in the meantime (exited/killed/errored — e.g. the daemon
restarted, or the adapter process crashed), the daemon attempts one
resume before giving up; if that doesn't bring it back, the request
fails with `409 {"error":"session_not_alive","status":"<exited|killed|error>"}`
and `chat`/`chat-tui` print `prompt failed: HTTP 409: …` instead of
silently going nowhere. `chat`'s own readline loop won't send a
second prompt while a turn is still in flight, but the same route
also rejects an overlapping prompt outright (`409 {"error":"send_prompt_failed", message: "...is mid-turn — wait for it to finish or cancel"}`)
rather than queuing it — a prompt to a busy session is never silently
dropped or run out of order.

## In-session commands

| Input | Action |
|-------|--------|
| `/exit`, `/quit` | End the chat (and stop the session unless `--keep`). |
| `Ctrl-C` | Same as `/exit`. |

## Examples

```bash
# Mastra agent with a specific model
agentproto chat mastra-agent --model anthropic/claude-sonnet-4-6

# Claude Code in the current directory
agentproto chat claude-code --cwd .

# TUI with a custom system prompt
agentproto chat-tui claude-code --system "Answer in French."

# Leave the session alive after exit
agentproto chat mastra-agent --keep

# TUI, no automatic system prompt
agentproto chat-tui claude-code --system ""
```

## See also

- [`run.md`](./run.md) — one-shot turn, script-friendly
- [`sessions.md`](./sessions.md) — spawn, attach, watch, export persistent sessions
- [`serve.md`](./serve.md) — daemon that the chat connects to
- [`models.md`](./models.md) — list runnable models per adapter