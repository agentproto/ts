---
"@agentproto/adapter-opencode": patch
---

An `opencode-console` profile now always resolves with the token of the stored console login that owns its sub-account (org), never the active login's. When several logins are stored, ownership is proven from each login's `/api/orgs` (cached per login for 5 minutes, re-checked once before failing) before `/api/config` is called, so a valid login is no longer sent to an org it does not own and answered with a bare 403. New typed errors, both still `SubaccountError`: `OpencodeOrgOwnerNotFoundError` (names the profile, the sub-account and the parent account emails tried, and says the owning login is missing) and `OpencodeAccountExpiredError` (names the expired parent account by email and expiry date). Nothing is written to opencode.db and no token appears in any error.
