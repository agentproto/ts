---
"@agentproto/runtime": patch
---

A tunnel whose first probe after start or a hostname swap sees no public DNS answer now keeps the short settle ladder running instead of ending it, so a briefly inconsistent DoH resolver no longer reports `dns not yet visible on public resolvers` for the full health interval.
