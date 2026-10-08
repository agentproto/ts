---
"@agentproto/runtime": patch
---

Test-only: the mcp-events e2e full-story test now subscribes under a frozen clock and asserts `refreshBefore` exactly, instead of bounding the granted TTL delta by +50 ms of wall clock (which flaked on loaded CI runners).
