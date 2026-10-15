---
"@agentproto/secrets": minor
---

Full-shape OAuth capture: teach the provision recipes (claude-code-oauth,
codex/`oauth-subscription`) an optional `oauth` field map so a method resolves
the ENTIRE AIP-19 `oauth` value shape ({accessToken, refreshToken, expiresAt}),
not just a single access-token string — epoch-ms expiries normalize to ISO.
New `agentproto-secrets capture` verb: resolves that shape from the CLI's own
local login (never spawns a second login client — if none exists it exits 1
and points at `claude login` / `codex login`), seals it to the vault's local
keypair (0600, minted once), writes a 0600 `entries/<provider>.json`, and
prints a capability pointer (`agentproto-secrets://vault/<provider>?method=…&key=…`)
with no token value ever printed or logged.
