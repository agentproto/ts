---
"@agentproto/runtime": minor
---

Observe a harness's native context compaction (Claude Code, Codex): a usage drop the daemon did not cause emits the `agentproto:context-compacted` host event and a `[context] native compaction detected` transcript line.
The event says whether a checkpoint was written in the two minutes before (`guarded`); it changes no behaviour.
