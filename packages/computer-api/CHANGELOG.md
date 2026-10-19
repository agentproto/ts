# @agentproto/computer-api

## 0.2.1

### Patch Changes

- 9ebf51d: `computer` sandbox provider: session refcount. `config.maxSessions` is forwarded at create so the controller sizes the computer for it, boot and connect attach a session, pause and stop detach it, and the last session to stop removes the computer. A stop whose detach is not answered leaves the computer in place and reports it. A connect past the controller's cap is refused. A controller without the attach routes keeps the per-process count. `@agentproto/computer-api` gains `maxSessions` on the create request and `sessionsResponseSchema` for attach and detach.

  A daemon-connect failure on a freshly booted box now removes the box instead of pausing it; a reconnected box is still paused.

## 0.2.0

### Minor Changes

- 8b350d5: New package `@agentproto/computer-api`: the versioned public contract for the computer controller HTTP API (zod schemas and inferred types for create/get/exec/suspend/resume/rm, the error envelope, computer states and published ports, plus a `COMPUTER_API_VERSION` constant), with contract fixtures per endpoint. `@agentproto/sandbox-computer` now imports its schemas from that package instead of carrying local copies and validates every controller response (and create/exec request bodies) against them, so shape drift fails loudly; its test fake controller validates everything it emits the same way.
