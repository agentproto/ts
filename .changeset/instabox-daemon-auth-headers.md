---
"@agentproto/harness": minor
"@agentproto/worktree": minor
"@agentproto/sandbox": patch
---

Present a gated sandbox daemon's auth on the runtime's own MCP connection.

- `ConnectHarnessOptions`/`HarnessClient.connect` accept `headers`, passed to
  the Streamable HTTP transport's `requestInit`.
- `connectDaemonAgentSessionHost` forwards them through.
- `createSandboxAgentSessionHost` sends `BootedSandbox.authHeaders` (or
  `Authorization: Bearer <token>`) so providers whose daemon is gated at the
  box itself — InstaBox's per-box `--auth-token` behind a public, otherwise
  unauthenticated edge — authenticate instead of 401-ing and getting reaped.
