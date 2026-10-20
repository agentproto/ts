---
"@agentproto/runtime": patch
---

Continue-fresh now numbers the continuation suffix instead of appending it every generation: `name (continued)` → `name (continued 2)` → `name (continued 3)`, with the legacy repeated `(continued)` form collapsed. Applies to both session labels and titles.
