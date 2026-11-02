---
"@agentproto/worktree": patch
---

`branch gc restore`: an ancestor entry is reported `contained` only when the descendant that shares its target actually lands (`restored`, `already-present`, or `would-restore` in a dry run). When the descendant is refused or fails, the ancestor is `refused-conflict` or `failed` with a message naming the descendant and its result, since nothing then holds its commits. The dry-run message now reads "would be restored to <target> instead".
