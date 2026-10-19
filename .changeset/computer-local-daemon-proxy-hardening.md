---
"@agentproto/sandbox-computer": patch
---

`computer` sandbox provider, `daemonRoute` mode: the local loopback proxy now relays only the agentproto daemon's own endpoints (`/mcp`, `/sessions`, `/events`, `/sessions/:id/pty`, `/health`), normalizing `.`/`..` segments (including percent-encoded ones) before checking and forwarding so a raw traversal path cannot slip past the allowlist, and answers everything else with 404 without ever reaching the controller. A WebSocket upgrade handshake through the proxy now forwards correctly (the `Connection` header was dropped on that path, which kept the upstream daemon from ever recognizing the request as an upgrade). `close()` also drops any open keep-alive connection and terminates a live upgraded tunnel (e.g. `/sessions/:id/pty`) immediately instead of leaving either to idle out, so teardown is deterministic.
