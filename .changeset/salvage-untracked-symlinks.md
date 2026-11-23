---
"@agentproto/worktree": patch
---

Worktree salvage: an untracked symlink (e.g. to a directory) no longer aborts the salvage with ENOTSUP. The link is recreated in the archive with its target kept verbatim and listed in the manifest (`symlinks`); non-copyable entries (socket, fifo, device) are listed in `skippedEntries`. A failed salvage now removes the archive directory it created, and `restoreSalvage` recreates files, links and the patch.
