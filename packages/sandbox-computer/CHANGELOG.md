# @agentproto/sandbox-computer

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
