# @agentproto/sandbox-computer

## 0.3.0

### Minor Changes

- 7411ddf: `computer` sandbox provider: `daemonRoute` no longer requires `gatewayUrl`. A configuration that sets both is rejected with a clear error instead of silently falling back to the explicit gateway. This also applies when `gatewayUrl` comes from the stored provider profile or `COMPUTER_GATEWAY_URL`, so remove it before enabling `daemonRoute`. Ports can only be exposed with `daemonRoute` disabled. The `setup_sandbox_provider` fields document that `gatewayUrl` is optional and mutually exclusive with `daemonRoute`.

### Patch Changes

- 3abaa5d: `computer` sandbox provider: attach and detach can carry a stable session holder. `config.sessionHolder` (fallback `AGENTPROTO_SESSION_ID`) is sent as the optional `holder` body on attach and detach; a controller that tracks holders then treats a re-attach by the same holder as idempotent, so a restarted daemon no longer hits the 409 session limit against the slot its dead predecessor still held. In `daemonRoute` mode every relayed request (HTTP and WebSocket) also carries the holder as `X-Computer-Session-Holder`, so a controller proxy can attribute the activity to the right session slot. `@agentproto/computer-api` documents the optional body as `attachRequestSchema`.
- 3abaa5d: `computer` sandbox provider: attach and detach can carry a stable session holder. `config.sessionHolder` (fallback `AGENTPROTO_SESSION_ID`) is sent as the optional `holder` body on attach and detach, and in `daemonRoute` mode every relayed HTTP/WebSocket request carries `X-Computer-Session-Holder`. A controller that tracks holders treats a re-attach by the same holder as idempotent, so a restarted daemon re-attaches onto the slot its dead predecessor held instead of hitting the 409 session limit. `@agentproto/computer-api` adds the exported `attachRequestSchema` and `AttachRequest` type for the optional body; `@agentproto/sandbox-computer` adds the optional `sessionHolder` config and optional `holder` arguments on the controller client's `attach`/`detach`.
- Updated dependencies [3abaa5d]
- Updated dependencies [3abaa5d]
  - @agentproto/computer-api@0.2.2

## 0.2.1

### Patch Changes

- 6d8a531: `computer` sandbox provider: optional extra request headers (`extraHeaders` config, `COMPUTER_EXTRA_HEADERS`, and the `COMPUTER_ACCESS_CLIENT_ID` / `COMPUTER_ACCESS_CLIENT_SECRET` pair mapped to `CF-Access-Client-Id` / `CF-Access-Client-Secret`) for a controller reached through an authenticating proxy. Values are never logged and are redacted from errors.

  New `daemonRoute` mode (`config.daemonRoute` or `COMPUTER_DAEMON_ROUTE=1`): drive a computer through the controller's own URL instead of a per-port gateway. The provider keeps controller credentials out of client-facing handles — `BootedSandbox.mcpUrl`/`authHeaders` only ever carry the box's own per-box daemon token, never the controller-wide credential or the edge Access secret, so nothing persisted into a session descriptor or an exported MCP config can leak them. `expose()`/`extraPorts` are rejected with a clear error in this mode (the controller route reaches only the daemon's own port). The runtime setup fields gain `daemonRoute`, `accessClientId` and `accessClientSecret`.

  Also carries the daemon bearer / `/mcp` / `COMPUTER_GATEWAY_URL` / published-port recovery fixes from the previous provider change that did not reach main.

- bb2c1d4: `computer` sandbox provider, `daemonRoute` mode: the local loopback proxy now relays only the agentproto daemon's own endpoints (`/mcp`, `/sessions`, `/events`, `/sessions/:id/pty`, `/health`), normalizing `.`/`..` segments (including percent-encoded ones) before checking and forwarding so a raw traversal path cannot slip past the allowlist, and answers everything else with 404 without ever reaching the controller. A WebSocket upgrade handshake through the proxy now forwards correctly (the `Connection` header was dropped on that path, which kept the upstream daemon from ever recognizing the request as an upgrade). `close()` also drops any open keep-alive connection and terminates a live upgraded tunnel (e.g. `/sessions/:id/pty`) immediately instead of leaving either to idle out, so teardown is deterministic.
- 9ebf51d: `computer` sandbox provider: session refcount. `config.maxSessions` is forwarded at create so the controller sizes the computer for it, boot and connect attach a session, pause and stop detach it, and the last session to stop removes the computer. A stop whose detach is not answered leaves the computer in place and reports it. A connect past the controller's cap is refused. A controller without the attach routes keeps the per-process count. `@agentproto/computer-api` gains `maxSessions` on the create request and `sessionsResponseSchema` for attach and detach.

  A daemon-connect failure on a freshly booted box now removes the box instead of pausing it; a reconnected box is still paused.

- Updated dependencies [9ebf51d]
  - @agentproto/computer-api@0.2.1
  - @agentproto/sandbox@0.12.1

## 0.2.0

### Minor Changes

- 743fa74: New sandbox provider `@agentproto/sandbox-computer` (slug `computer`): boots the agentproto daemon on a self-hosted microVM computer through its controller HTTP API, with suspend=pause, resume (adopting the controller's rebuilt id), rm=stop, liveness probing, chunked exec-based file IO, and `sharedSessions: true` capability plus a per-process `maxSessions` cap. The runtime registry adds the `sharedSessions` capability field (default `false`) and stores token/controllerUrl credentials for the provider.
- 743fa74: New sandbox provider `@agentproto/sandbox-computer` (slug `computer`): boots the agentproto daemon on a self-hosted microVM computer through its controller HTTP API, with suspend=pause, resume (adopting the controller's rebuilt id), rm=stop, liveness probing, chunked exec-based file IO, and a `sharedSessions: true` capability plus a per-process `maxSessions` cap.

  `@agentproto/runtime` gains the optional `sharedSessions` sandbox-provider capability field (default `false`) and stores controller token/URL credentials for the provider.

### Patch Changes

- 8b350d5: New package `@agentproto/computer-api`: the versioned public contract for the computer controller HTTP API (zod schemas and inferred types for create/get/exec/suspend/resume/rm, the error envelope, computer states and published ports, plus a `COMPUTER_API_VERSION` constant), with contract fixtures per endpoint. `@agentproto/sandbox-computer` now imports its schemas from that package instead of carrying local copies and validates every controller response (and create/exec request bodies) against them, so shape drift fails loudly; its test fake controller validates everything it emits the same way.
- 78a3983: `computer` sandbox provider: forward a configurable `egress` allowlist on create (the controller denies all egress, DNS included, without one), and add an optional `tenantId` setup field that fills `COMPUTER_TENANT_ID` from the stored provider profile.

  Boot now works for the unprivileged guest user: the CLI installs under `~/.local` (global `/usr/local` is root-owned), the daemon log moves from `/var/log` (not writable) to `~/.agentproto-daemon.log`, and a non-zero exit from the CLI install or a setup command fails the boot with the step's output instead of timing out on health.

  The boot skips the npm CLI install when the image already carries an `agentproto` CLI (an extra `installPackages` list or a non-matching pinned `cliVersion` still installs), and `gatewayUrl` accepts a `{hostPort}` placeholder resolved from the host port the controller published for the daemon port, so a daemon outside the controller's network can reach a computer through a port forward.

  The pinned `cliVersion` is compared by exact version (a partial pin such as `1.2` no longer matches `1.26.0`), and a reconnect restarts a healthy in-box daemon whose recorded `--allow-origin` no longer matches the current `{hostPort}` origin.

- Updated dependencies [8b350d5]
- Updated dependencies [629e42c]
- Updated dependencies [629e42c]
- Updated dependencies [74f982c]
- Updated dependencies [629e42c]
- Updated dependencies [74f982c]
  - @agentproto/computer-api@0.2.0
  - @agentproto/sandbox@0.12.0
