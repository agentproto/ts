---
"@agentproto/acp": patch
"@agentproto/driver-agent-cli": patch
"@agentproto/adapter-opencode": patch
---

Refuse to spawn a derived-from-model adapter on its default model when the requested model was rejected. Launching opencode with an id its server can't resolve (e.g. a claude-code-style `…@openrouter` suffix) used to warn on the daemon's stderr and silently run — and bill — the server's default `anthropic/claude-sonnet-4-5` instead. The ACP client now records a connect-time model rejection structurally (`AcpClientSession.modelApplyRejection`), and the agent-cli driver turns that into a spawn failure for `routeSelection:"derived-from-model"` adapters (opencode & co., where the model id IS the route and the bill), naming the requested id, the server's reason, and the adapter's expected `<provider>/<model>` shape. Free/fixed-routing adapters keep the agentproto#186 warn-and-continue behavior unchanged.
