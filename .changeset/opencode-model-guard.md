---
"@agentproto/acp": patch
"@agentproto/driver-agent-cli": patch
"@agentproto/adapter-opencode": patch
---

Refuse to spawn a derived-from-model adapter on its default model when the requested model was not applied. Launching opencode with an id its server can't resolve (e.g. a claude-code-style `…@openrouter` suffix) used to warn on the daemon's stderr and silently run — and bill — the server's default `anthropic/claude-sonnet-4-5` instead; hermes had the same hole one strategy over (its spawn-time `/model <id>` control turn's result was ignored, so an unacknowledged switch also continued silently). The ACP client now records a connect-time model rejection structurally (`AcpClientSession.modelApplyRejection`), and the agent-cli driver refuses the spawn for `routeSelection:"derived-from-model"` adapters on BOTH apply strategies — a rejected `set_config_option` (opencode-style `apply:"config"`) and an unacknowledged/failed `/model` control turn (hermes-style `apply:"command"`) — naming the requested id, the concrete reason, and the adapter's expected `<provider>/<model>` shape. Free/fixed-routing adapters keep the agentproto#186 warn-and-continue behavior unchanged.
