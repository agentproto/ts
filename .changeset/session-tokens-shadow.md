---
"@agentproto/runtime": minor
---

Per-session identity tokens in shadow mode: each spawned claude-code or hermes session gets a daemon-minted token on its daemon self-mount, stored hashed in `session-credentials.json` and revoked when the session retires (`defaults.identity.sessionTokens`, default `"shadow"`).
The daemon counts verified, mismatching, invalid, claim-only and anonymous callers and serves the counts at `GET /identity`; no request is refused or reclassified.
