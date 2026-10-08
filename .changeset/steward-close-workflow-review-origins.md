---
"@agentproto/apps": patch
---

session-steward: `workflow` (workflow-step sessions) and `review` (reviewer lanes) are now closable origins by default. They are one-shot sessions spawned by the engine, never by a human, but an unrecognized root origin was treated as user-origin and therefore flag-only, so finished ones piled up. Still gated by idle time and a confident `done`/`abandoned` verdict.
