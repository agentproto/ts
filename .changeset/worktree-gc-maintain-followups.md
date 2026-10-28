---
"@agentproto/worktree": minor
"@agentproto/cli": minor
"@agentproto/runtime": patch
"@agentproto/apps": patch
---

Follow-ups on `worktree gc`/`status` and the `maintain` workflow:

- `worktree gc --apply` (and the daemon's `worktree_gc` apply from a precomputed plan) re-checks each entry's branch, HEAD sha and index mtime right before touching it, and skips with `skipped-stale` if anything moved since the plan was made.
- Liveness now consults the daemon's session registry (an alive session whose cwd is the worktree, or under it, blocks reclaim) and the newest mtime among modified/untracked files, not only the index; it degrades to mtime-only and says so when the daemon is unreachable.
- `pnpm-lock.yaml` is noise only when the worktree's `package.json` files are unchanged versus HEAD; a changed manifest keeps the lockfile as real dirt. An explicit `--noise` override still wins outright.
- `worktree ls --status` and the gc/maintain integration state gain `closed-unmerged(#N)` for a branch whose PR was closed without merge.
- The `maintain` reviewer input carries each candidate's PR state (open/merged/closed-unmerged/none) and a `git cherry` summary against the compare base; the maintain report prints one reason line per verdict.
- Forge resolution normalizes `github.com-<alias>` SSH host aliases to `github.com` for the owner/repo slug, resolves the `gh` token from a neutral cwd, and both `ls --status` and `gc` print once to stderr when PR status can't be fetched instead of staying silent.
- `worktree gc` lists and classifies worktrees with bounded concurrency instead of serially, cutting a ~40-worktree sweep from the 50s+ range down substantially (see PR body for before/after numbers).
