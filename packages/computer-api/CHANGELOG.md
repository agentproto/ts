# @agentproto/computer-api

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
