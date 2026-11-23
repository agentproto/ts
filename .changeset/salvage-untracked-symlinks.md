---
"@agentproto/worktree": minor
---

Worktree salvage: an untracked symlink (e.g. to a directory) no longer aborts the salvage with ENOTSUP. The link is recreated in the archive with its target kept verbatim and listed in the manifest (`symlinks`); untracked directories (including nested git repos) are archived recursively, and names git would C-quote are read with `ls-files -z`; non-copyable entries (socket, fifo, device) are listed in `skippedEntries`. A failed salvage now removes the archive directory it created, and `restoreSalvage` recreates files, links and the patch.
