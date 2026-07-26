---
"@agentproto/runtime": patch
"agentproto-vscode": patch
---

Fix Codex native OpenAI launch contract. A fixed-provider adapter (e.g. codex with `provider: "openai"`) matched against its own native gateway preset (`route.gateway: "openai"`) is now treated as a direct route: subscription mode stays eligible, the preset `base_url` is dropped, and no `base_url` option is injected. Non-native gateway presets and custom third-party routes remain unsupported for such adapters and are rejected at spawn time; the Configuration Lab filters them out of the route list.
