---
"@agentproto/apps": patch
"@agentproto/runtime": minor
"@agentproto/worktree": minor
---

Show branch PR state and evidence in the maintain decision queue. `branch_gc` plan entries for unmerged local and remote refs now carry `headPr`, the forge's PR for the branch name (open, newest merged, newest closed-unmerged, or none) read from bulk PR lists, through the new optional `ForgeClient.listClosedUnmergedPullRequests`. The maintain report prints that PR state instead of `unknown`, gives every human decision queue row its stored verdict, PR state and the reviewer's reason, prints one batch `agentproto branch gc approve` command (a sha per line, flags last), and its Worktrees header says `mode: apply` when worktree_gc applied.
