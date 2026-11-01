---
"@agentproto/runtime": minor
---

A spawn that mounts a stdio MCP server whose command the workspace allowlist does not admit is now counted by an `observe`-by-default `defaults.spawn.stdioMountGate`, readable on `GET /permissions/grants` under `stdioMounts`. `enforce` refuses it with `stdio_mount_denied`.
