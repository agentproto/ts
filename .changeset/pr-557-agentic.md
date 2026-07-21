---
"@agentproto/driver": minor
"@agentproto/cli": minor
"@agentproto/runtime": minor
"@agentproto/adapter-claude-code": minor
"@agentproto/adapter-claude-sdk": minor
"@agentproto/adapter-hermes": minor
"@agentproto/adapter-mastra-agent": minor
"@agentproto/adapter-mastracode": minor
"@agentproto/adapter-mastracode-inprocess": minor
"@agentproto/adapter-opencode": minor
"@agentproto/adapter-pi": minor
---

Implement route-selection axis for AIP-45 launch-menu drill-down (WP1): add declarative `routeSelection` field to adapter manifests (distinguishes "free" vs. "derived-from-model"), project it through resolve/runtime layers, enrich catalog with per-route `multiModel` flags and flat routes index for tier-pinning logic.
