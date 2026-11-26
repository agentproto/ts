---
"@agentproto/voice": minor
---

Add a processor pipeline to the cascade engine: `Transformer` (on the path, measured budget, fail-open, circuit breaker) and `Observer` (off the path, read-only, bounded queue), `defineTransformer` / `defineObserver`, `ProcessorConfigError` raised at mount for missing or duplicate names, shared facets without `after`, and bad budgets, `processors` in the start options, `hooks.onProcessorEvent`, `session.getProcessorStats()`, and `BrainEvent` (`activity`, `tool-start`) so a long tool call resets the brain guards. The `textOut` point (reply text before sentence splitting and TTS) is active; `audioIn`, `transcript` and `audioOut` are reserved. `@agentproto/voice/testing` gains `runProcessorContractSuite` and `makeReferenceProcessorSession`.
