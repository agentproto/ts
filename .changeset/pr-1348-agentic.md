---
"@agentproto/corpus-cli": patch
---

Fix AssemblyAI STT adapter rejecting explicit `null` `text`/`language_code`/`error` fields on queued/processing poll responses; fields are now `.nullish()` and a regression test covers the queued → processing → completed flow.
