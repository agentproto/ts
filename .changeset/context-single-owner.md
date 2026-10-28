---
"@agentproto/runtime": patch
---

Context compaction has one owner: the percent-band compaction is no longer attempted, an auto-compaction writes one checkpoint instead of two, and it holds the context lock until its compaction turn has ended so a prompt arriving meanwhile waits instead of failing it with "mid-turn".
The turn-boundary continue-fresh takes the same lock, so auto-compact and continue-fresh never both act on one session.
