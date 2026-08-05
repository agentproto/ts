---
"@agentproto/runtime": patch
---

Fix spawn-claim deduplication window to match real retry latencies: increased from 30s to 10 minutes to absorb the caller's timeout (300s) plus network/clock skew, with an LRU size backstop (1,000 resolved claims) to prevent unbounded growth. Add non-blocking warning when two live sessions share the same label+cwd, aiding incident detection without breaking legitimate fan-out patterns.
