---
"@agentproto/runtime": minor
---

Observe a harness's native context compaction (Claude Code, Codex) as a passive usage-drop detector: a drop the daemon did not cause emits the `agentproto:context-compacted` host event and a `[context] native compaction detected` transcript line, with a `guarded` flag recording whether a checkpoint was written shortly before. No behaviour changes.
