---
"@agentproto/sandbox-computer": patch
"@agentproto/runtime": patch
---

`computer` sandbox provider: optional extra request headers (`extraHeaders` config, `COMPUTER_EXTRA_HEADERS`, and the `COMPUTER_ACCESS_CLIENT_ID` / `COMPUTER_ACCESS_CLIENT_SECRET` pair mapped to `CF-Access-Client-Id` / `CF-Access-Client-Secret`) for a controller reached through an authenticating proxy. Values are never logged and are redacted from errors.

New `daemonRoute` mode (`config.daemonRoute` or `COMPUTER_DAEMON_ROUTE=1`): the daemon URL defaults to `<controllerUrl>/v1/computers/{id}/daemon` and `authHeaders` carries the controller credential (`X-Controller-Authorization`) and tenant (`X-Tenant-Id`) beside the daemon's own bearer, so one controller URL is enough to drive a computer. The runtime setup fields gain `daemonRoute`, `accessClientId` and `accessClientSecret`.

Also carries the daemon bearer / `/mcp` / `COMPUTER_GATEWAY_URL` / published-port recovery fixes from the previous provider change that did not reach main.
