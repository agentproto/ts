---
"@agentproto/runtime": minor
---

Context floor (`hardStopAtPct`) now auto-compacts instead of hard-stopping: the runtime checkpoints, runs `/compact` (`/compress` on hermes), holds incoming prompts with a retryable "mid-turn" error while it works, and only falls back to continue-fresh and then a stop when compaction cannot bring the window down. Autonomous turns now evaluate the policy at turn end, stale hard-stop flags on live sessions are cleared, and every outcome is announced in the transcript and as a `session:context-rescue` event.
