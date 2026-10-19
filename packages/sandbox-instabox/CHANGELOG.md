# @agentproto/sandbox-instabox

## 0.2.2

### Patch Changes

- @agentproto/sandbox@0.12.2

## 0.2.1

### Patch Changes

- Updated dependencies [9ebf51d]
  - @agentproto/sandbox@0.12.1

## 0.2.0

### Minor Changes

- 629e42c: Add the InstaBox sandbox provider (`@agentproto/sandbox-instabox`, AIP-36).

  - New `SandboxQuotaError` in `@agentproto/sandbox` and a `truncated` flag on `SandboxExecResult`.
  - `instaboxSandboxProvider` boots an InstaBox VM (always `vault:false`, `onTimeout:"kill"`), installs the agentproto daemon as a systemd unit with a 0600 EnvironmentFile, publishes the daemon port through the public edge, never suspends boxes, deletes the machine on boot failure, and maps account-quota failures to `SandboxQuotaError`.
  - Registered in the runtime provider catalog and the CLI (credential env key `INSTABOX_API_KEY`).

### Patch Changes

- 629e42c: Fix reattach and event streaming against a gated sandbox daemon, and a silent readFile failure.

  - `SandboxAgentSessionHost` exposes `authHeaders`; the runtime sandbox proxy
    sends them on its raw HTTP reads (`GET /sessions/:id`, the backlog read and
    the SSE event stream). Without them a bearer-gated daemon (InstaBox) answered
    401, so a session could never be re-attached after a host restart and the
    event stream always fell back to polling.
  - InstaBox `readFile` guards its `dd | base64` pipeline with `test -r`, so a
    missing or unreadable file rejects instead of resolving to empty bytes.

- 629e42c: Harden the InstaBox daemon unit by running `agentproto serve` as the unprivileged `user` account (matching `@agentproto/sandbox-box`), remove a dead exit-code check in `readExistingAuthToken`, and add a harness regression test asserting `ConnectHarnessOptions.headers` reach the MCP transport.
- Updated dependencies [629e42c]
- Updated dependencies [629e42c]
- Updated dependencies [74f982c]
- Updated dependencies [629e42c]
- Updated dependencies [74f982c]
  - @agentproto/sandbox@0.12.0
