---
"@agentproto/runtime": patch
---

Fix flaky startFromFile test by rooting fixtures inside project instead of OS temp dir, ensuring vitest's module resolver keeps imports deterministic.
