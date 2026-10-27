# @agentproto/computer-api

## 0.4.0

### Minor Changes

- 61e6068: Add common sandbox list and usage surface with W0b fields
- 61e6068: Add the common sandbox list and usage surface. `@agentproto/sandbox` gains the `SandboxBox` and `SandboxUsageWindow` types plus optional `list()`/`usage()` methods on `SandboxProvider`; `@agentproto/computer-api` gains the `GET /v1/usage` schemas/types and additive W0b list fields; `@agentproto/sandbox-computer` implements `list()`/`usage()` and `ComputerControllerClient.getUsage()`, keeping absent controller fields absent.

## 0.3.0

### Minor Changes

- ab53381: Add AIP-36 v1.3 egress IP selection and capacity errors to the computer sandbox provider: `config.egressIp` / spec-level `network.egressIp` (`"shared"`, `"auto"`, `"dedicated"`, or a pool slot id) is validated and forwarded at create when not shared, `BootedSandbox.egressIp` reports the controller's `{id, publicIp} | null` on boot and connect, and controller failures map to typed `ComputerSandboxError` codes including `sandbox_capacity` with `resource`/`requested`/`available`/`retryAfterMs`.

  The provider validates the controller's `egressIp` field with the typed `@agentproto/computer-api` contract, so a malformed `egressIp` in a controller response fails the call instead of being ignored.

- fb025f0: Provider-control-plane orphan GC: `agentproto sandbox gc` and the new `sandbox_gc` MCP tool sweep a provider for boxes it still holds (and still charges RAM for) that the daemon's sandbox registry never knew and that no live session references, listing them (state, age, memory) and deleting them with `remove(..., { force: true })` only under `--apply` (dry run by default).

  A candidate must be PAST A 15-MINUTE GRACE WINDOW (`ORPHAN_GRACE_MS`) and carry NO attached session (`sessions === 0`); the new `--include-attached` CLI flag (and the MCP tool's `includeAttached`) lifts the attached-session check explicitly. A box the provider does not date can never be proven stale and is never proposed. The shared gone-detection of the ledger gc (`GONE_RE`/`isGoneError`) now also decides "already disappeared" on the provider sweep, and a sweep that never ran (no daemon, no provider configured, no `listBoxes`) is reported as `not scanned` instead of "no orphan found".

  Adds `SandboxProvider.listBoxes`/`SandboxProviderBox`, the computer provider's `GET /v1/computers` listing (`ComputerControllerClient.listComputers`), the `computerListEntrySchema`/`computerListResponseSchema` contract, and the `--provider` / `--include-attached` CLI flags. A box held by a live session is never a candidate and a failing provider is reported without stopping the sweep of the others.

## 0.2.3

### Patch Changes

- b22adfe: Docs-only sync of the two READMEs with the already-shipped stable session-holder behavior (#2114): `computer-api` documents the idempotent `holder` re-attach (200 with the session count unchanged), and `sandbox-computer` documents that a re-connect by the same `sessionHolder` is idempotent and keeps its slot. No runtime change.

## 0.2.2

### Patch Changes

- 3abaa5d: `computer` sandbox provider: attach and detach can carry a stable session holder. `config.sessionHolder` (fallback `AGENTPROTO_SESSION_ID`) is sent as the optional `holder` body on attach and detach; a controller that tracks holders then treats a re-attach by the same holder as idempotent, so a restarted daemon no longer hits the 409 session limit against the slot its dead predecessor still held. In `daemonRoute` mode every relayed request (HTTP and WebSocket) also carries the holder as `X-Computer-Session-Holder`, so a controller proxy can attribute the activity to the right session slot. `@agentproto/computer-api` documents the optional body as `attachRequestSchema`.
- 3abaa5d: `computer` sandbox provider: attach and detach can carry a stable session holder. `config.sessionHolder` (fallback `AGENTPROTO_SESSION_ID`) is sent as the optional `holder` body on attach and detach, and in `daemonRoute` mode every relayed HTTP/WebSocket request carries `X-Computer-Session-Holder`. A controller that tracks holders treats a re-attach by the same holder as idempotent, so a restarted daemon re-attaches onto the slot its dead predecessor held instead of hitting the 409 session limit. `@agentproto/computer-api` adds the exported `attachRequestSchema` and `AttachRequest` type for the optional body; `@agentproto/sandbox-computer` adds the optional `sessionHolder` config and optional `holder` arguments on the controller client's `attach`/`detach`.

## 0.2.1

### Patch Changes

- 9ebf51d: `computer` sandbox provider: session refcount. `config.maxSessions` is forwarded at create so the controller sizes the computer for it, boot and connect attach a session, pause and stop detach it, and the last session to stop removes the computer. A stop whose detach is not answered leaves the computer in place and reports it. A connect past the controller's cap is refused. A controller without the attach routes keeps the per-process count. `@agentproto/computer-api` gains `maxSessions` on the create request and `sessionsResponseSchema` for attach and detach.

  A daemon-connect failure on a freshly booted box now removes the box instead of pausing it; a reconnected box is still paused.

## 0.2.0

### Minor Changes

- 8b350d5: New package `@agentproto/computer-api`: the versioned public contract for the computer controller HTTP API (zod schemas and inferred types for create/get/exec/suspend/resume/rm, the error envelope, computer states and published ports, plus a `COMPUTER_API_VERSION` constant), with contract fixtures per endpoint. `@agentproto/sandbox-computer` now imports its schemas from that package instead of carrying local copies and validates every controller response (and create/exec request bodies) against them, so shape drift fails loudly; its test fake controller validates everything it emits the same way.
