---
"@agentproto/runtime": minor
"@agentproto/adapter-pi": minor
"@agentproto/adapter-claude-sdk": minor
"@agentproto/provider-presets": minor
"@agentproto/cli": patch
"@agentproto/driver-agent-cli": patch
---

Dissociate auth profiles from routers/gateways and harness adapters. Session descriptors now carry explicit `harness`, `model`, `route`, and `accessProfile` identity. Runtime resolver derives api-key auth from the model and gateway route, injecting `base_url` + credential env without adapter hard-coding. Add native Moonshot support to `pi`, decouple `claude-sdk` from hard-coded gateway modes, and register a local `llm-endpoint` preset.
