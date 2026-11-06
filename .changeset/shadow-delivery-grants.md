---
"@agentproto/delivery": minor
"@agentproto/sentinel": minor
"@agentproto/runtime": minor
---

Record a shadow `grant` verdict (`allow`, `deny`, `unknown` or `error`) on every delivery ledger line. The check observes publish and wake capabilities but never changes delivery; a throwing or slow decision leaves delivery untouched and is recorded as `error`.
