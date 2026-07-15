# `agentproto run`

```text
agentproto run <slug> [--cwd <dir>] [--prompt <text>] [--model <id>] [--effort <level>]
                      [--resume <session-id>] [--json]
                      [--output-schema <path-or-inline-json>] [--hold-permissions]
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
| `--model <id>` | Adapter model option (e.g. `claude-opus-4-8` or `openrouter/z-ai/glm-5.2`). |
| `--effort <level>` | Adapter effort option (e.g. `low`, `medium`, `high`). |
| `--resume <session-id>` | Resume an existing adapter session by id. Adapter-specific — Claude Code's session ids, for example. |
| `--json` | Emit one JSON event per line instead of pretty stream. |
| `--output-schema <path-or-inline-json>` | Validate the agent's final answer against a JSON Schema and print ONLY the matching JSON. Inline when the first non-space char is `{`, otherwise a path to a `.json` file. Cannot be combined with `--json`. |
| `--hold-permissions` | Start in permission-hold mode: each tool-permission request is surfaced (as an `agent-prompt` event) and **held** instead of auto-answered. Since one-shot `run` has no inbox of its own, the turn **blocks** on the first gated tool call until you Ctrl-C — it's a way to *see* what an agent would ask for. For the approvable flow, use a daemon-backed session ([`sessions.md`](./sessions.md) `--hold-permissions`) plus [`permissions.md`](./permissions.md). |

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

## Output (schema mode)

`--output-schema` turns `run` into a structured-output verb: the agent is
told its final answer MUST be a single JSON object matching the supplied
[JSON Schema](https://json-schema.org/), and stdout becomes EXACTLY that
JSON (compact, one line, trailing newline). Every log — streamed text,
tool calls, turn-end, validation notes — goes to stderr, so the stdout of a
successful run is safe to pipe straight into `jq`.

```bash
agentproto run claude-code -p "did the tests pass?" \
  --output-schema '{"type":"object","required":["passed"],
                    "properties":{"passed":{"type":"boolean"}}}' \
  | jq -e '.passed'
```

The schema argument is inline JSON when its first non-whitespace character
is `{`; otherwise it's read as a path to a `.json` file:

```bash
agentproto run claude-code -p "grade this PR" --output-schema ./verdict.schema.json
```

Behaviour:

- On a match, stdout is the validated JSON and the exit code is `0`.
- On a mismatch (unparseable, or fails validation), the turn is re-prompted
  with the validation errors up to **twice** before giving up. On final
  failure stdout stays empty, the errors print on stderr, and the exit code
  is `1`.
- Validation is a full JSON Schema check (via `ajv`), so `required`,
  nested `properties`, `items`, `enum`, `additionalProperties`, and the
  rest of the draft are all enforced.
- `--output-schema` cannot be combined with `--json` (both own stdout); the
  combination exits `2`. An unreadable file or unparseable/uncompilable
  schema also exits `2` before any adapter is spawned.

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

# Schema-validated final answer — stdout is exactly the JSON
agentproto run claude-code -p "did the tests pass?" \
  --output-schema '{"type":"object","required":["passed"],"properties":{"passed":{"type":"boolean"}}}' \
  | jq -e '.passed'
```

## Cancellation

`SIGINT` / `SIGTERM` cancels the turn cleanly — the underlying
`AbortController` is forwarded to the adapter, the session is closed,
and the verb returns. A second Ctrl-C falls back to default Node
behaviour (hard exit) in case the adapter is stuck.
