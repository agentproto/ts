---
"@agentproto/acp": patch
"@agentproto/driver-agent-cli": patch
"@agentproto/adapter-opencode": patch
"@agentproto/adapter-jcode": patch
---

Refuse to run a derived-from-model adapter on its default model when the requested model was not applied. Launching opencode with an id its server can't resolve (e.g. a claude-code-style `…@openrouter` suffix) used to warn on the daemon's stderr and silently run — and bill — the server's default `anthropic/claude-sonnet-4-5` instead; hermes had the same hole one strategy over (its spawn-time `/model <id>` control turn's result was ignored), and jcode a protocol over (its CLI silently falls back to its own default on an unknown `--model` id — observed live: `--model totally-bogus-xyz` → started on `gpt-5.6-sol`/OpenAI). Three guards now share one contract for `routeSelection:"derived-from-model"` adapters: the ACP client records a connect-time model rejection structurally (`AcpClientSession.modelApplyRejection`) and the driver refuses the spawn on a rejected `set_config_option` (opencode-style `apply:"config"`) or an unacknowledged/failed `/model` control turn (hermes-style `apply:"command"`); the print arm aborts a turn whose jcode-ndjson `start` line reports a model contradicting the requested one (basename compare, `@route`-suffix/`provider/`-prefix tolerant). Every refusal names the requested id and the concrete reason. Free/fixed-routing adapters keep the agentproto#186 warn-and-continue behavior unchanged; pi errors properly on its own (`Model not found`) and needs no guard.
