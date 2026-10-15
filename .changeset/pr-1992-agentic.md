---
"@agentproto/secrets": minor
---

Add a `capture` CLI verb plus an optional `oauth` field map on provision
recipes. A method can now declare dot-paths into its login document for the
full AIP-19 `oauth` value shape (`{accessToken, refreshToken, expiresAt}`),
and `capture` resolves that shape from the CLI's own local login, seals it to
the vault's local keypair, writes a `0600` `entries/<provider>.json`, and
prints a token-free capability pointer. Epoch-ms expiries normalize to ISO.
