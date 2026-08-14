---
"@agentproto/runtime": patch
---

Fix critical data loss bugs in sessions registry: add per-write unique tmp file names to prevent concurrent write truncation, serialize persist rounds to prevent interleaved snapshots, and quarantine malformed files instead of silently overwriting them.
