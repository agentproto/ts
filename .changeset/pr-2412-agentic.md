---
"@agentproto/runtime": minor
---

Add an observe-by-default `defaults.spawn.stdioMountGate` that evaluates the `stdio` entries a caller names in `agent_start.mcpServers` against the workspace command allowlist (`allowed-commands.json`), counting would-deny mounts in `GET /permissions/grants` under `stdioMounts` and, in `enforce`, refusing them with `stdio_mount_denied`. Routes `mcp.mount.stdio` through `decide()` and wires the allowlist loader through the root and scoped orchestrator gateways.
