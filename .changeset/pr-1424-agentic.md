---
"@agentproto/runtime": minor
"@agentproto/driver-agent-cli": minor
---

Live-session teardown fixes: `DELETE /sessions/:id` (and `registry.forget`) now tears a still-running session down through the full kill teardown (adapter close, PTY/child SIGTERM, `session:exited` emit) before dropping the row, returning an additive `killed` field; adapter closes in the agent CLI now terminate the whole child process tree (SIGTERM → grace period → SIGKILL) so `npx` wrappers, MCP servers, and headless Chrome can no longer outlive the session.
