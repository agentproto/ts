---
"@agentproto/cli": minor
---

feat(cli): `agentproto chat <adapter>` — an interactive multi-turn REPL on a
daemon-hosted agent session.

Where `run` is one-shot and `sessions --attach` is read-only output, `chat` is
the human loop: type a line → watch the agent's reply stream back (text,
`[tool]` calls, `[thought]`s, `turn-end`) → type again. It's a thin client over
the daemon — `POST /sessions/agent` to spawn, `POST /sessions/:id/prompt` per
turn, `GET /sessions/:id/stream` for output (the daemon already renders the
lines). `/exit`, `/quit` or Ctrl-C ends it and stops the session unless
`--keep`. Supports `--model`, `--cwd`, `--workspace`, `--label`, `--no-color`.

Also adds a `--model` option to `agentproto sessions start` so a session's
model can be chosen from the CLI (previously daemon-defaulted only).
