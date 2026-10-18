---
"@agentproto/sandbox": patch
"@agentproto/runtime": patch
"@agentproto/sandbox-instabox": patch
---

Fix reattach and event streaming against a gated sandbox daemon, and a silent readFile failure.

- `SandboxAgentSessionHost` exposes `authHeaders`; the runtime sandbox proxy
  sends them on its raw HTTP reads (`GET /sessions/:id`, the backlog read and
  the SSE event stream). Without them a bearer-gated daemon (InstaBox) answered
  401, so a session could never be re-attached after a host restart and the
  event stream always fell back to polling.
- InstaBox `readFile` guards its `dd | base64` pipeline with `test -r`, so a
  missing or unreadable file rejects instead of resolving to empty bytes.
