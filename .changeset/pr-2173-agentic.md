---
"@agentproto/runtime": minor
"agentproto-vscode": minor
---

Live model switch now uses the running agent's own vocabulary instead of the catalog id.

`SessionDescriptor.configOptions` (runtime) is a read-time projection of the live harness's advertised ACP `configOptions` (stamped at `list()`/`get()`, never persisted), and `POST /sessions/:id/model` sends an advertised value verbatim rather than catalog wire-normalizing it. The VS Code model picker (`changeModel` / `sessionConfig`) re-reads the live session, offers the agent's accepted values as extra rows, and flags catalog ids the agent would reject as restart-only.
