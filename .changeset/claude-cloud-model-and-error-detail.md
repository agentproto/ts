---
"@agentproto/adapter-claude-code-cloud": patch
"@agentproto/acp": patch
---

AIP-66 cloud spawn model + error detail.

The `claude-code-cloud` manifest now declares a free-form string `model` option (applied via `ANTHROPIC_MODEL` env on the relay's claude children — the same channel the local `claude-code` adapter uses), so `agent_start { cloud: "anthropic", adapter: "claude-code-cloud", model: "claude-opus-5-5" }` no longer fails with `[unknown_option at config.options.model] Option 'model' is not declared by manifest 'claude-code-cloud'. Known options: (none)`. Omitting `model` still leaves the vendor's own default in place; no curated `models` menu is added (the vendor bills its own models, AIP-66 §4).

The ACP client no longer swallows the cause of a refused spawn/turn behind a bare "Internal error": the SDK maps a server-side handler throw to a JSON-RPC `-32603` whose message is just "Internal error" and keeps the real reason only in `error.data.details` (a missing claude.ai credential, an unpushed checkout, a vendor API error, …). `newSession` / `loadSession` / prompt turn errors now surface that detail in the message (carrying the `-32603` code through), so the host shows the actual refusal.
