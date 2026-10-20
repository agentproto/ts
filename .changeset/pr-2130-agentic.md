---
"@agentproto/model-catalog": patch
"@agentproto/catalog-sync": patch
---

Add MiniMax-M3.1-Flash pricing and keep committed first-party MiniMax rows (including their cache-write multipliers) when a retired model leaves MiniMax's pricing page instead of re-pricing it from OpenRouter. Updates the MiniMax pricing fixtures/tests to cover the new page shape.
