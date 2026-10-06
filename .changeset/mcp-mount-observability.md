---
"@agentproto/runtime": minor
---

`session_capabilities` now reports what a session's harness actually loaded from the daemon's own `/mcp` mount: optional `status` (`declared` | `connected` | `listed` | `error` | `never-contacted`), `toolCount`, `tools`, `deferred`, `protocolVersion`, `lastSeenAt` and `error` on `mcpServers[]`. The daemon also emits an `mcp:degraded` session event (visible in `session_events_poll`) when a turn ends with the mount never listed, listing zero tools or failing.
