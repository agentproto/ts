---
"@agentproto/cli": patch
"@agentproto/runtime": patch
---

Session-index follow-up fixes that missed the #1665 squash: capText slices by code point (no lone-surrogate split at the 500/300 boundary), backfilled `startedAt` uses the transcript's birthtime, and `sessions find --limit` is capped at 200 to match the MCP surface.
