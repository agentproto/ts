---
"@agentproto/sandbox-computer": patch
"@agentproto/runtime": patch
---

`computer` sandbox provider: forward a configurable `egress` allowlist on create (the controller denies all egress, DNS included, without one), and add an optional `tenantId` setup field that fills `COMPUTER_TENANT_ID` from the stored provider profile.

Boot now works for the unprivileged guest user: the CLI installs under `~/.local` (global `/usr/local` is root-owned), the daemon log moves from `/var/log` (not writable) to `~/.agentproto-daemon.log`, and a non-zero exit from the CLI install or a setup command fails the boot with the step's output instead of timing out on health.

The boot skips the npm CLI install when the image already carries an `agentproto` CLI (an extra `installPackages` list or a non-matching pinned `cliVersion` still installs), and `gatewayUrl` accepts a `{hostPort}` placeholder resolved from the host port the controller published for the daemon port, so a daemon outside the controller's network can reach a computer through a port forward.

The pinned `cliVersion` is compared by exact version (a partial pin such as `1.2` no longer matches `1.26.0`), and a reconnect restarts a healthy in-box daemon whose recorded `--allow-origin` no longer matches the current `{hostPort}` origin.

The in-box daemon's `--auth-token` is now returned on `BootedSandbox.token`/`authHeaders` (and persisted `0600` in the box for reconnects) so the host can reach the published port, `mcpUrl` ends in `/mcp`, `gatewayUrl` is also read from `COMPUTER_GATEWAY_URL` and exposed as a runtime setup field (a daemon-restart re-attach carries no per-spawn config), and a reconnect recovers the published host port from the origin marker when the controller's GET omits `ports`.
