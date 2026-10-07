---
"@agentproto/runtime": patch
"@agentproto/apps": patch
"@agentproto/cli": patch
---

Repo maintenance: reviewers spawn again. A workflow agent step started in a review worktree (`branch_gc_review_worktree`) now gets that worktree and its repo's git dir as read-only zones, so `reviewOne` passes the app boundary check and git can read the branch under the OS sandbox. Before, every reviewer was refused with `app_boundary_cwd_outside` and the run recorded no verdicts. A look-alike directory in the review root is still refused. The maintain report also groups one failure that hit several branches as a single reason. `agentproto workflow status` prints step labels. Compact `workflow_status` folds repeated circuit-open skips into one row and caps large run outputs.
