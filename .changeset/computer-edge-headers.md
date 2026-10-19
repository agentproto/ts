---
"@agentproto/sandbox-computer": patch
"@agentproto/runtime": patch
---

`computer` sandbox provider: optional extra request headers (`extraHeaders` config, `COMPUTER_EXTRA_HEADERS`, and the `COMPUTER_ACCESS_CLIENT_ID` / `COMPUTER_ACCESS_CLIENT_SECRET` pair mapped to `CF-Access-Client-Id` / `CF-Access-Client-Secret`) for a controller reached through an authenticating proxy. Values are never logged and are redacted from errors.

New `daemonRoute` mode (`config.daemonRoute` or `COMPUTER_DAEMON_ROUTE=1`): drive a computer through the controller's own URL instead of a per-port gateway. The provider keeps controller credentials out of client-facing handles — `BootedSandbox.mcpUrl`/`authHeaders` only ever carry the box's own per-box daemon token, never the controller-wide credential or the edge Access secret, so nothing persisted into a session descriptor or an exported MCP config can leak them. `expose()`/`extraPorts` are rejected with a clear error in this mode (the controller route reaches only the daemon's own port). The runtime setup fields gain `daemonRoute`, `accessClientId` and `accessClientSecret`.

Also carries the daemon bearer / `/mcp` / `COMPUTER_GATEWAY_URL` / published-port recovery fixes from the previous provider change that did not reach main.
