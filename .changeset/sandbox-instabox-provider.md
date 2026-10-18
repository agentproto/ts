---
"@agentproto/sandbox-instabox": minor
"@agentproto/sandbox": minor
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Add the InstaBox sandbox provider (`@agentproto/sandbox-instabox`, AIP-36).

- New `SandboxQuotaError` in `@agentproto/sandbox` and a `truncated` flag on `SandboxExecResult`.
- `instaboxSandboxProvider` boots an InstaBox VM (always `vault:false`, `onTimeout:"kill"`), installs the agentproto daemon as a systemd unit with a 0600 EnvironmentFile, publishes the daemon port through the public edge, never suspends boxes, deletes the machine on boot failure, and maps account-quota failures to `SandboxQuotaError`.
- Registered in the runtime provider catalog and the CLI (credential env key `INSTABOX_API_KEY`).
