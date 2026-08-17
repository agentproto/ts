---
"@agentproto/runtime": minor
---

Implement WP-R4: per-workspace RULES.md injection. Enables workspace supervisors to define standing rules that automatically inject into every agent spawn in the workspace, carrying workspace-wide discipline like "main checkout untouchable", "PR-only never merge", "no AI attribution" without needing to hand-type them into every brief. Rules are read from the workspace's state bucket and injected ahead of the role disposition to establish the fundamental layer before role-specific behavior.
