# `agentproto run`

```text
agentproto run <slug> [--cwd <dir>] [--prompt <text>] [--resume <session-id>] [--json]
```

Spawns the adapter named by `<slug>`, dispatches a single user turn,
streams events to stdout, then exits. Two designed use cases:

- One-shot scripting (pipe a prompt in, get a stream back).
- Smoke-testing a fresh install ("does this adapter even spawn?").

For persistent sessions you can detach + reattach, use
[`sessions.md`](./sessions.md). For long-running multi-agent
loops, use [`run-swarm.md`](./run-swarm.md).

## Flags

| Flag | Purpose |
|------|---------|
| `--cwd <dir>` | Working directory the adapter is spawned in. Default `process.cwd()`. |
| `--prompt <text>`, `-p <text>` | The user turn. Required if stdin isn't piped. |
| `--resume <session-id>` | Resume an existing adapter session by id. Adapter-specific — Claude Code's session ids, for example. |
| `--json` | Emit one JSON event per line instead of pretty stream. |

If `--prompt` is omitted, stdin is read when piped:

```bash
echo "summarise" | agentproto run claude-code
git diff | agentproto run claude-code -p "Review this diff"   # diff over stdin AND a prompt
```

When neither `--prompt` nor a piped stdin is present, the verb exits
`2` with a usage error.

## Output (pretty mode, default)

Streams human-friendly tokens to stdout:

- `text-delta` events → written to stdout verbatim
- `tool-call` → `[tool] <name>` on stderr (dim cyan)
- `tool-result` → no output unless `isError`, then `[tool-error]` on stderr
- `thought` → `[thought] <text>` on stderr (dim grey)
- `agent-prompt` → `[agent-prompt: needs input]` on stderr (yellow)
- `turn-end` → `\n[turn-end: <reason>]` on stderr
- `error` → `[error] <message>` on stderr; child stderr + structured
  `error.data` follow on subsequent dim lines for debugging

Exit code is `1` when the stream emits an `error` event or
`turn-end.reason !== "completed"`; otherwise `0`.

## Output (JSON mode)

```bash
agentproto run claude-code -p "hello" --json
# {"kind":"text-delta","text":"Hi"}
# {"kind":"text-delta","text":"!"}
# {"kind":"turn-end","reason":"completed"}
```

One JSON object per line. Useful for piping into `jq` or wiring into
non-CLI tooling.

## Examples

```bash
# Quick smoke test
agentproto run claude-code -p "Say 'hello'."

# Pipe a file as the prompt
cat REVIEW_REQUEST.md | agentproto run claude-code

# Continue an existing Claude Code session
agentproto run claude-code --resume 7f8e2c4b-… -p "now refactor that"

# Different cwd
agentproto run claude-code --cwd ~/code/widgets -p "What does this repo do?"

# Machine-readable
agentproto run claude-code -p "hello" --json | jq -r 'select(.kind=="text-delta") | .text'
```

## Cancellation

`SIGINT` / `SIGTERM` cancels the turn cleanly — the underlying
`AbortController` is forwarded to the adapter, the session is closed,
and the verb returns. A second Ctrl-C falls back to default Node
behaviour (hard exit) in case the adapter is stuck.
