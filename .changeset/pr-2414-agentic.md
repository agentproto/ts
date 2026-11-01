---
"@agentproto/sentinel": minor
"@agentproto/runtime": minor
---

Give PR-watch sentinels one owner rule: the auto-linked `auto:pr#N` sentinel now targets the session that recorded the PR and that session's live parent, and a sentinel whose target is dead or retired with no successor is re-targeted to the live parent (rather than parked) so the supervisor is never left blind. `sweepWiringLifecycle` follows the same rule. Adds the optional `resolveParentSession` auto-link option and wires it from the gateway.
