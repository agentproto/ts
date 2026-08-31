---
"@agentproto/cli": minor
"@agentproto/pack": minor
"@agentproto/plugin": minor
---

Rename "plugins" to "adapters" in the CLI to free up "plugin" for Agent Plugins v1.0.0 standard. This is a breaking change: `agentproto plugins` → `agentproto adapters`, config key `plugins[]` → `adapters[]`, manifest schema `agentproto/plugin/v1` → `agentproto/adapter/v1`.

Introduce `@agentproto/pack` (AIP-52 PACK.md reference implementation) and `@agentproto/plugin` (Agent Plugins v1.0.0 reference implementation) packages.
