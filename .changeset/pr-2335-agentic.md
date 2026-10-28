---
"@agentproto/runtime": minor
---

Per-session identity tokens in shadow mode (ts#2165 step 5): spawned claude-code/hermes sessions receive a daemon-minted token on the adapter's daemon self-mount, stored hashed in `session-credentials.json` and revoked on retirement, while the persisted descriptor never carries a token. `defaults.identity.sessionTokens` (default `"shadow"`) enables it and `GET /identity` reports the caller counts.
