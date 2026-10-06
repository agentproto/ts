---
"@agentproto/adapter-pi": patch
---

A pi turn that ends with `stopReason: "error"` (e.g. an OpenRouter 402 "requires more credits") now carries pi's own `errorMessage` into the runtime: the adapter emits an in-band `error` event before `turn-end`, read from `turn_end.message.errorMessage` / `agent_end.messages[]` when pi skipped the `message_update` error. `lastTurnErrorMessage`, the `session:turn-end` error and cron run summaries show the cause instead of a bare "error".
