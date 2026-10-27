---
"@agentproto/agent": patch
---

Fix loading an AGENT.md whose `on:` value is an array, the multi-action form AIP-42 documents. The generated schema typed an action ref as `z.any()`, so an array matched both branches of the `oneOf` and the load failed with "Should pass single schema. Passed 2". `on:` values are now validated as a string or object action ref, or an array of them, so a bare number is rejected where it used to load.
