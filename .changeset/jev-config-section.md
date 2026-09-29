---
"@agentproto/runtime": minor
---

Add a `jev` config section (`jev.apiKey`, `jev.model`, `jev.baseUrl`) to `~/.agentproto/config.json`. `resolveJevApiKey` reads `jev.apiKey` before the `JEV_API_KEY` env var, giving agentproto's first-party judge secret a home in its own config instead of a workspace env file.
