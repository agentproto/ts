---
"@agentproto/runtime": patch
"@agentproto/sandbox-e2b": patch
---

Fix sandbox spec field forwarding in HTTP path and prevent VM leaks on boot/reconnect failures.

**@agentproto/runtime**: Fixed #1150 regression where `POST /sessions/agent` silently dropped `extraPorts`, `env`, `lifecycle`, and other fields from inline sandbox specs. Extracted shared schema `sandboxSpecWithReuseSchema` to ensure both HTTP and MCP paths validate against identical schema and forward all fields.

**@agentproto/sandbox-e2b**: Centralized sandbox cleanup on boot/reconnect failure to prevent VM leaks (observed live: six boxes left running without sessions). Added fast-fail mechanism that exits immediately when daemon crashes during boot, surfacing captured stderr for diagnostics, instead of blocking the full readiness timeout.
