---
"@agentproto/apps": patch
"@agentproto/runtime": patch
---

repo-maintenance: the review agents (the maintain workflow's large-residual reviewer and the repo-maintenance reviewer agent) now default to `claude-sonnet-5-5` instead of `claude-sonnet-5`. Override per run with the workflow's `reviewModelLarge` input as before.

@agentproto/runtime: test-only update asserting the new default review model id in the repo-maintenance workflow routing tests.
