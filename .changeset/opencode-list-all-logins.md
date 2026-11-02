---
"@agentproto/adapter-opencode": patch
---

`agentproto auth subaccounts list` for the opencode console now also lists the orgs of the other stored logins, not only the active one. A non-active login that is expired or whose `/api/orgs` call fails is skipped; an expired active login still fails the listing.
