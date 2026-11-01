---
"@agentproto/runtime": patch
---

Drain in-flight transcript writes in the pre-compact checkpoint route test teardown to avoid an ENOTEMPTY race when the temp dir is removed. Test-only change; no runtime behavior change.
