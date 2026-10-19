---
"@agentproto/sandbox-computer": minor
---

`computer` sandbox provider, `daemonRoute` mode: the local loopback proxy now relays only the agentproto daemon's own endpoints (`/mcp`, `/sessions`, `/events`, `/sessions/:id/pty`) and answers everything else with 404 without ever reaching the controller, closing off the controller credential as an accidental open relay. A WebSocket upgrade handshake through the proxy now forwards correctly (the `Connection` header was dropped on that path, which kept the upstream daemon from ever recognizing the request as an upgrade). `close()` also drops any open keep-alive connection immediately instead of waiting for it to idle out, so teardown is deterministic.
