---
"@agentproto/adapter-claude-code": patch
"@agentproto/adapter-claude-sdk": patch
"@agentproto/adapter-codex": patch
"@agentproto/adapter-pi": patch
"@agentproto/cli": patch
"@agentproto/driver-agent-cli": minor
"@agentproto/model-catalog": minor
"@agentproto/provider-presets": patch
"@agentproto/runtime": minor
---

Fix routing and credential injection for gateway-routed adapters (D1-D5)

- D1: Base URL injection gate — skip gateway baseUrl for derived-from-model adapters (hermes); fail loud when adapter can neither accept baseUrl nor derive its route
- D2: Wire model form — generalized stripFixedNativeVendor for fixed-provider adapters (codex/openai, codex/gpt-5 not openai/gpt-5)
- D3: Model-derived provider precedence — adapter-declared modelProviders wins over global catalog routing (pi bills kimi via moonshot, not openrouter)
- D4: Gateway credential injection — resolveAuthSpec honors adapter-declared gatewayAuth.setEnv instead of preset keyEnv (claude-sdk reads ANTHROPIC_AUTH_TOKEN, not OPENROUTER_API_KEY)
- D5: LLM endpoint adoption — status report never contradicts (running:false, healthy:true); adopt external healthy endpoints as owner:external with probed model list

New exports: LlmEndpointStatusReport, stripFixedNativeVendor, routeSelection in AgentAdapterResolver.
