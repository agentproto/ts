---
"@agentproto/worktree": patch
---

Fix a race in the fast-remove background deleter that could leave a stale `.trash/.deleting` pid file behind. The parent used to write the pid file after spawning the deleter, so a fast deleter could drain the trash and run its EXIT trap first, leaving a permanent stale file (a stale pid could then wrongly suppress spawning a deleter after PID reuse). The deleter now writes its own pid after installing its trap, and the parent only writes a placeholder before the spawn.
