---
"@agentproto/runtime": patch
---

Fix PR deduplication after force-pushes by extracting commit SHA from the provenance footer instead of relying on GitHub's API `commit_id` field, which drifts during branch mutations. Store full 40-character SHA in footer for unambiguous tracking.
