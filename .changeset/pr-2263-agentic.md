---
"@agentproto/runtime": minor
---

Reaction chains now carry their causation through every arm: the runner derives each receipt's reaction depth and caused event id from the completing session's facts, enters an async reaction context around every target, and stamps sessions spawned inside it with origin and reaction meta. The depth cap therefore bounds sessions started by tool and workflow reactions too. This mirrors the existing `.changeset/action-hooks-reaction-causation.md` in the PR.
