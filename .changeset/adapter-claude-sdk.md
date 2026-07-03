---
"@agentproto/adapter-claude-sdk": minor
"@agentproto/cli": patch
---

Add first-party `@agentproto/adapter-claude-sdk` — runs Claude Code's agent
harness as a library via the Claude Agent SDK's headless `query()` behind an
AIP-44 ACP server. 100% Anthropic-native I/O: clean model pinning
(`options.model`, no spawn-arg rejection — #186), native per-turn usage
(`usage_update` with tokens + cost — #186 P3), and a custom `base_url`
(`ANTHROPIC_BASE_URL`) to front real Anthropic, Bedrock/Vertex/Azure, or an
Anthropic-compatible gateway. Registered in the install catalog so
`adapter_list` discovers it with its `model`/`base_url` options.
