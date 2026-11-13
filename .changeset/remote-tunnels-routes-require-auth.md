---
"@agentproto/runtime": patch
"@agentproto/relay": patch
---

`POST /remote/enable`, `POST /remote/disable` and the mutating `/tunnels*` routes (create, delete, revoke, hostnames, login, provider credentials) now take the same gate as the mutating `/sessions/*` routes: a foreign browser Origin is refused, the per-boot token (or an allowlisted Origin) is required, and POST, PUT and PATCH must send `content-type: application/json` (415 otherwise). `GET /remote/status` and the read-only `/tunnels` routes are unchanged. `agentproto-relay --tunnel` now sends the daemon token on `POST /tunnels`; the `agentproto remote` and `agentproto tunnel` commands already did.
