---
"@agentproto/runtime": minor
"@agentproto/apps": patch
---

Context settings now layer setting by setting over the request, adapter and daemon blocks: a spawn that sets only some keys inherits the others from the adapter and daemon blocks instead of the built-in defaults. `contextSettings` is the AIP-46 name of the block on `agent_start`, `POST /sessions/agent` and in `defaults.contextSettings` and `defaults.adapters.<slug>.contextSettings`; `contextContinuity` stays an alias. `config_set` accepts the new keys.
