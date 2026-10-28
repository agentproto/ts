---
"@agentproto/memory": minor
"@agentproto/corpus-cli": patch
---

New `@agentproto/memory` package for AIP-72 `memory/v1` items: `defineMemory` (writer path, canonical fields required, throws a `MemoryValidationError` naming the field), `validateMemory` (schema plus the single-document AIP-72 rules, returning `{ ok, errors, warnings }` with field paths), `parseMemory` / `renderMemory` (round-trip stable MEMORY.md with every string double-quoted), and the lifecycle helpers `memoryStatus`, `isAllowedStatusTransition` and `isInForce`.

The bundled AIP schemas are re-synced with agentproto/agentproto main: `aip-72/draft/MEMORY.schema.json` is added, and `pending/memory` and `pending/harness` are removed.
