---
"@agentproto/cli": minor
"@agentproto/runtime": minor
"agentproto-vscode": minor
---

Add build identity tracking to CLI and runtime. Captures git SHA and build timestamp at build time, and judges source (workspace vs published) at runtime. This enables operators to distinguish between workspace distributions and published tarballs of the same version via `daemon start`/`status` output and `/health` endpoint.

New exports:
- `renderBuild()` from `@agentproto/cli/commands/daemon`

New optional fields:
- `DaemonHealthInfo.build` 
- `CreateGatewayOptions.build`
- `RuntimeHttpServerOptions.build`
- `DaemonHealth.build` (VS Code)
