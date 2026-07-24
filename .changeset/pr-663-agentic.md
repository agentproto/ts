---
"@agentproto/driver-agent-cli": minor
---

Export `createArmSessionControls` to enable hosts that build their own `AgentCliRuntimeSession` over alternative transports (e.g., e2b sandbox, remote daemon) to reuse the live-session control surface and capability read-surface members without hand-copying and drifting on future interface changes.
