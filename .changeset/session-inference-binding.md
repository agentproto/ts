---
"@agentproto/llm-endpoint": minor
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Bind a spawned session to a local/LAN inference endpoint via `agent_start.inference` (`{endpoint}` / `{endpoint, model}` / `{model: "<model>@<device|endpoint>"}`), with a harness fit check (known first-request token size vs the endpoint's loaded ctx, 25% headroom by default, `force` overrides) run BEFORE spawn — claude-code/claude-sdk route through the `llm-endpoint` gateway, pi talks to the endpoint directly and syncs its `models.json` first. Defaults the harness to `pi` when no adapter is chosen. `agentproto llm endpoints test` and `doctor`'s local-models check now show loaded ctx and which harnesses fit.
