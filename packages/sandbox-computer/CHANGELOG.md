# @agentproto/sandbox-computer

## 0.6.1

### Patch Changes

- f3511ad: Send the descriptive join metadata (`AGENTPROTO_JOIN_NAME`, `_PROVIDER`, `_SANDBOX_ID`, `_LABELS`) to the box daemon through its start command instead of the create env, so the controller's argv check no longer refuses the daemon start exec when a short value such as `computer` appears in the box origin.
  - @agentproto/sandbox@0.15.1

## 0.6.0

### Minor Changes

- 3b505bf: A computer `create` answered `503 fleet-capacity` is now retried for up to `fleetCapacityWaitMs` (default 12 minutes) instead of failing the spawn at once, honouring `Retry-After`/`fleetCapacityRetryMs`, stopping on cancellation, not counting the wait against `bootDeadlineMs`, and reusing one `Idempotency-Key` per boot. The `auto` provider disables this wait for its computer leg when e2b overflow is enabled so a capacity refusal still overflows immediately.
- 3b505bf: A computer create answered `503 fleet-capacity` is now retried instead of failing the spawn at once: the provider waits while the fleet frees or wakes a shelved host, for up to `fleetCapacityWaitMs` (default 12 minutes, `0` restores the old behaviour). Each wait honours `Retry-After`, else `fleetCapacityRetryMs` (default 30 s), is logged on the boot log, stops on cancellation, and does not count against `bootDeadlineMs`. Every attempt of one boot carries the same `Idempotency-Key`, so a replayed create never makes a second box. The `auto` provider turns the wait off for its computer leg when overflow to e2b is enabled, so a capacity refusal still overflows at once.

### Patch Changes

- 01796b2: Size the box Node heap from its memory and document the template contract
- 8a28a15: Reap stale paused boxes, kill reused boxes on kill, bound create
- 8a28a15: Sandbox lifecycle leak fixes: an explicit `agent_kill` now tears down a reuse-only box instead of leaving it paused, the periodic sandbox GC reaps paused dead-session rows past a configurable age bound (`AGENTPROTO_SANDBOX_GC_PAUSED_MAX_AGE_MS`), and gone-box reconnect failures are recognised via the shared sentinel. `@agentproto/runtime` also exports `DEFAULT_PAUSED_BOX_MAX_AGE_MS` and `parsePausedBoxMaxAge`. `@agentproto/sandbox-computer` logs the create deadline phase and controller rejection reason so a stuck spawn no longer fails silently.
- Updated dependencies [e395b66]
  - @agentproto/sandbox@0.15.0

## 0.5.0

### Minor Changes

- 61e6068: Add common sandbox list and usage surface with W0b fields
- 89012c2: Add typed capacity refusal codes and an isCapacityRefusal predicate
- 804db17: Make computer sandbox boot visible, bounded, and honest about impossible capacity: register a `starting` session row before the box boots and adopt it once the driver session exists (with a new `sandbox` provisioning phase), give the whole provider boot one deadline that fails with a typed `sandbox_boot_timeout` naming the stuck phase, refuse requests above the tenant's total budget with `sandbox_capacity_exceeds_budget`, log one daemon line per boot phase through the new optional `SandboxBootOpts.log`, and abort a boot whose `starting` row is killed (provider create requests are aborted on a create-phase deadline, and a completed boot is torn down so a killed spawn can never resurrect). `sandbox-computer` also gains `ComputerControllerClient.getCapacity()`, the `bootDeadlineMs` config, and additive error fields (`budget`, `phase`, `timeoutMs`, `sandboxId`); its bump is `minor` because those exports are new.
- 61e6068: Add the common sandbox list and usage surface. `@agentproto/sandbox` gains the `SandboxBox` and `SandboxUsageWindow` types plus optional `list()`/`usage()` methods on `SandboxProvider`; `@agentproto/computer-api` gains the `GET /v1/usage` schemas/types and additive W0b list fields; `@agentproto/sandbox-computer` implements `list()`/`usage()` and `ComputerControllerClient.getUsage()`, keeping absent controller fields absent.
- 89012c2: Add typed capacity-refusal handling: new `sandbox_fleet_capacity`, `sandbox_tenant_running_cap`, `sandbox_end_user_cap`, and `sandbox_fleet_tenant_cap` error codes, an additive `cap` field on the error types, and an exported `isCapacityRefusal` predicate that classifies by controller body code rather than HTTP status.

### Patch Changes

- 84ac51b: Move the typed session presets from `@agentproto/harness` to `@agentproto/session-presets`. This is step 1 of 2 for AIP-45: the presets moved to `@agentproto/session-presets`, and the name `@agentproto/harness` now carries the AIP-45 runner (see the aip-45 changeset). `@agentproto/worktree` now imports the new package. The sandbox providers only update a doc comment that names the package, so they take a patch bump to satisfy the changeset coverage gate.
- Updated dependencies [61e6068]
- Updated dependencies [1d7b55a]
- Updated dependencies [d3dd524]
- Updated dependencies [5ab8114]
- Updated dependencies [804db17]
- Updated dependencies [5ab8114]
- Updated dependencies [61e6068]
  - @agentproto/computer-api@0.4.0
  - @agentproto/sandbox@0.14.0

## 0.4.0

### Minor Changes

- ab53381: Add AIP-36 v1.3 egress IP selection and typed capacity errors to the computer sandbox provider: `config.egressIp` / spec-level `network.egressIp` (`"shared"`, `"auto"`, `"dedicated"`, or a pool slot id) is validated and forwarded at create when not shared, `BootedSandbox.egressIp` reports the controller's `{id, publicIp} | null` on boot and connect, and controller failures map to typed `ComputerSandboxError` codes including `sandbox_capacity` with `resource`/`requested`/`available`/`retryAfterMs`.

  The provider validates the controller's `egressIp` field with the typed `@agentproto/computer-api` contract, so a malformed `egressIp` in a controller response fails the call instead of being ignored.

- ab53381: Add AIP-36 v1.3 egress IP selection and capacity errors to the computer sandbox provider: `config.egressIp` / spec-level `network.egressIp` (`"shared"`, `"auto"`, `"dedicated"`, or a pool slot id) is validated and forwarded at create when not shared, `BootedSandbox.egressIp` reports the controller's `{id, publicIp} | null` on boot and connect, and controller failures map to typed `ComputerSandboxError` codes including `sandbox_capacity` with `resource`/`requested`/`available`/`retryAfterMs`.

  The provider validates the controller's `egressIp` field with the typed `@agentproto/computer-api` contract, so a malformed `egressIp` in a controller response fails the call instead of being ignored.

- fb025f0: Provider-control-plane orphan GC: `agentproto sandbox gc` and the new `sandbox_gc` MCP tool sweep a provider for boxes it still holds (and still charges RAM for) that the daemon's sandbox registry never knew and that no live session references, listing them (state, age, memory) and deleting them with `remove(..., { force: true })` only under `--apply` (dry run by default).

  A candidate must be PAST A 15-MINUTE GRACE WINDOW (`ORPHAN_GRACE_MS`) and carry NO attached session (`sessions === 0`); the new `--include-attached` CLI flag (and the MCP tool's `includeAttached`) lifts the attached-session check explicitly. A box the provider does not date can never be proven stale and is never proposed. The shared gone-detection of the ledger gc (`GONE_RE`/`isGoneError`) now also decides "already disappeared" on the provider sweep, and a sweep that never ran (no daemon, no provider configured, no `listBoxes`) is reported as `not scanned` instead of "no orphan found".

  Adds `SandboxProvider.listBoxes`/`SandboxProviderBox`, the computer provider's `GET /v1/computers` listing (`ComputerControllerClient.listComputers`), the `computerListEntrySchema`/`computerListResponseSchema` contract, and the `--provider` / `--include-attached` CLI flags. A box held by a live session is never a candidate and a failing provider is reported without stopping the sweep of the others.

### Patch Changes

- 43e1fbc: Detach and tear down computer boxes on session kill, crash, and shared-box survivor teardown.
- e4d1185: Run `sandbox_exec` against an existing computer box without consuming a session slot or disturbing the in-box daemon: adds an optional `SandboxProvider.connectForExec` exec-only attach path and has `sandbox_exec` prefer it, falling back to `connect()` for providers that don't implement it. Note: the PR already carries an equivalent changeset (`.changeset/sandbox-exec-no-session-slot.md`); this file is only a reviewer handoff and may be dropped if the existing one is kept.
- 43e1fbc: Detach and tear down computer boxes on session kill, crash, and shared-box survivor teardown. A killed session on a shared box now releases its provider/controller slot without stopping the box under the survivors, an operator kill on an already-ended (crashed-adapter) sandbox row retries box teardown, and the computer provider's holder-scoped detach is idempotent. Adds an optional `detach()` seam to `BootedSandbox`/`SandboxAgentSessionHost`. Note: the PR already carries an equivalent changeset (`.changeset/computer-box-detach-leaks.md`); this file is only a reviewer handoff.
- e4d1185: Run sandbox_exec on a busy computer box without taking a session slot or disturbing its daemon.
- a63eafb: fix(sandbox): never lose work to a box that outlives its welcome — bounded pre-deadline checkpoints, host-side rescue push on a wedged low-disk session, release dead-session boxes, capacity-free teardown

  - A session's end-of-turn checkpoint raced the provider's reaper: the box
    hit its E2B lifetime mid-turn ("sandbox not found") and the periodic
    checkpoint had pushed nothing. The deadline-near checkpoint is now
    BOUNDED to the remaining lifetime minus a safety margin (it never runs
    past the deadline), and a renewal while a turn is in flight is retried
    instead of falling through to the checkpoint branch after one failure.
  - Low disk + a wedged session (ENOSPC never settles after interrupt):
    when a forced low-disk checkpoint does not secure the box's work, the
    proxy runs a HOST-side rescue push — `git add -A` + `commit
--no-verify` + force-push to a `rescue/<session>` branch, executed via
    `sandbox exec`, and emits the rescue outcome as an agent warning.
  - A session that DIED (crashed / killed / errored) used to leave its box
    paused and RAM-held (the computer provider kept answering "capacity
    exhausted (available 511)"). The watchdog-driven death now ends with
    `close({ deathRelease: true })`: checkpoint → notify → REALLY release
    the box (kill/stop, never a memory-holding pause).
  - Teardown and `sandbox rm --box` never need capacity: `SandboxProvider`
    gains an optional `remove(sandboxId)` that destroys the box on the
    control plane WITHOUT connecting to it (which used to RESUME a
    suspended computer just to delete it, needing free RAM first).
    `sandbox gc` / reaping prefers `remove`; a periodic automatic
    `sandbox gc` runs on the daemon (1 h cadence,
    `AGENTPROTO_SANDBOX_GC_INTERVAL_MS` overrides / disables) reaping
    boxes whose origin session is dead.

- Updated dependencies [43e1fbc]
- Updated dependencies [e4d1185]
- Updated dependencies [ab53381]
- Updated dependencies [43e1fbc]
- Updated dependencies [ab53381]
- Updated dependencies [e4d1185]
- Updated dependencies [fb025f0]
- Updated dependencies [a63eafb]
  - @agentproto/sandbox@0.13.0
  - @agentproto/computer-api@0.3.0

## 0.3.1

### Patch Changes

- b22adfe: Docs-only sync of the two READMEs with the already-shipped stable session-holder behavior (#2114): `computer-api` documents the idempotent `holder` re-attach (200 with the session count unchanged), and `sandbox-computer` documents that a re-connect by the same `sessionHolder` is idempotent and keeps its slot. No runtime change.
- Updated dependencies [b22adfe]
  - @agentproto/computer-api@0.2.3
  - @agentproto/sandbox@0.12.2

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
