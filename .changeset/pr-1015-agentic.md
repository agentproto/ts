---
"@agentproto/code-brain": minor
---

Add `queryManySources` utility for client-side multi-source fan-out queries. Parallelizes `graphQuery` calls across multiple sources, deduplicates results by file+span (with title+body fallback), and returns a single score-ranked hit list.
