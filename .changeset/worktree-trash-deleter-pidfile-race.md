---
"@agentproto/worktree": patch
---

fix(worktree): the background trash deleter now records its own pid, so a deleter that finishes before the parent resumes can no longer leave a stale `.trash/.deleting` behind (which kept `.trash` from ever reading as empty and could suppress a later deleter if the pid was reused)
