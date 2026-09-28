---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Join-token host visibility follow-ups (SANDBOX-VISIBILITY-JOIN, stacked on #1517/#1535): a CI-joined box's `AGENTPROTO_JOIN_PROVIDER`/`AGENTPROTO_JOIN_LABELS` env are now forwarded into the sandbox the same gated way `AGENTPROTO_JOIN` already is, and `join-token-registry.ts` synthesizes `"<token name> #<pr>"` for a box that doesn't self-report a name (it never knows the token's own name — only the home daemon does).

A failed `addHost()` round trip (the daemon dialing back into a joined box's self-minted offer) is now recorded on the join token as `lastJoinError`/`lastJoinErrorAt` instead of only logging it — `useCount` bumping with no matching device update is no longer silent. The box's self-offer TTL widened from 60s to 3min to give that round trip more slack under real broker latency.

`HostRegistry` now caches the last successful `GET /sessions*` response per host and serves it (`stale: true`, with a capture timestamp) when a subsequent forward to an offline host fails — wired through `device-registry.ts`'s `forwardHttp`, the `device_sessions` MCP tool, and `GET /devices/:id/sessions[/:id/output]`. A join-token-added host is now tagged (`HostRecord.addedVia`) and pruned after `joinedHostTtlMs` (default 7 days) of no `lastSeen` activity; a manually paired host (`pair offer --host` + `devices add`) is never auto-pruned.
