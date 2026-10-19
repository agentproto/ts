---
"@agentproto/acp": patch
"@agentproto/adapter-claude-code-cloud": patch
---

AIP-66 cloud spawn `model` option + richer ACP error detail.

`claude-code-cloud` now declares a free-form string `model` option, applied via the `ANTHROPIC_MODEL` env var on the relay's claude children (the same channel the local `claude-code` adapter uses), so `agent_start` naming a model no longer fails with `unknown_option`. Omitting it leaves the vendor's own default in place and no curated `models` menu is added (the vendor bills its own models, AIP-66 §4).

The ACP client now surfaces the cause of a refused spawn/turn hidden behind a bare JSON-RPC `-32603` "Internal error": `newSession` / `loadSession` / prompt-turn errors include the human-readable `error.data.details` in the message while carrying the `-32603` code through, so a host that reads only `error.message` shows the real refusal (missing credential, unpushed checkout, vendor API error) instead of a bare "Internal error".
