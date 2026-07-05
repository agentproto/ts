---
"@agentproto/runtime": minor
---

`agent_prompt` gains an `interrupt` flag. When true and the target session is
mid-turn, the daemon cancels the in-flight turn (the CLI-side equivalent of
Ctrl-C — ACP `session/cancel`, or SIGINT for process adapters), waits for it to
settle, then delivers the new prompt on the same live session — redirecting a
running agent without killing it and losing its context. Default false keeps the
existing mid-turn rejection byte-identical.
