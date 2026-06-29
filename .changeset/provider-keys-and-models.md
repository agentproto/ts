---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

provider API-key store + `agentproto models` — configure providers and see runnable models

- **`agentproto auth provider set|list|rm`** — store LLM provider API keys
  (anthropic, openrouter, openai, …) in `~/.agentproto/providers.json` (mode
  0600). `serve` injects them into the daemon env at boot, so every spawned
  agent (mastra-agent, hermes, …) can reach the provider without an ambient
  `export FOO_API_KEY`. Explicit env always wins. `list` masks key material.
- **`agentproto models [adapter]`** — lists each adapter's models marked ✓/✗ by
  whether its provider has a key, enriched with $/Mtok pricing from
  `@agentproto/model-catalog`. Surfaces "no ANTHROPIC_API_KEY" up front instead
  of at runtime.
