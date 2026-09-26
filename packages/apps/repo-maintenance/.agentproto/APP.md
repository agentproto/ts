---
schema: app/v1
id: '@agentproto/repo-maintenance'
name: Repo Maintenance
version: 0.1.0
description: >-
  Plans and (opt-in) applies branch_gc + worktree_gc for a repo, with a
  reviewer agent fanned out over every unmerged branch candidate before any
  apply happens. Built on the branch_gc/branch_gc_verdict/worktree_gc tools
  (agentproto/ts).
agents:
  - id: '@agentproto/repo-maintenance-reviewer'
    path: .agentproto/agents/repo-maintenance-reviewer/AGENT.md
workflows:
  - id: maintain
    path: .agentproto/workflows/maintain/WORKFLOW.md
---

Plans and (opt-in) applies branch_gc + worktree_gc for a repo, with a
reviewer agent fanned out over every unmerged branch candidate before any
apply happens. See README.md for how to install and run it, and
`routines/` for the daily/weekly scheduled templates.
