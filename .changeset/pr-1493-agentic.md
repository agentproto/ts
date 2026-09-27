---
"@agentproto/runtime": minor
---

Daemon-supervises the llm-endpoint gateway: crash-restart policy for `LlmEndpointRegistry`, boot autostart + `ensureLlmEndpointRunning` self-heal hook for spawns, `GET /llm-endpoint/status` + `POST /llm-endpoint/restart` REST routes, and the `resolveEffectiveLlmEndpointFlag` smart-default resolver (new exports).
