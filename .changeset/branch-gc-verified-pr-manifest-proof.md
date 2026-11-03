---
"@agentproto/worktree": patch
"@agentproto/runtime": patch
"@agentproto/apps": patch
---

branch gc: the verified-pr pass now also explains an uncovered file the cited PR did not touch when the dep-bump per-file rules prove every line it changes (recorded as `why: "manifest-proven"`, shown by `maintain` as `N manifest-proven`), and the dep-bump rules prove a `packageManager` pin `<name>@<version>[+<hash>]` when base declares the same manager at the same or a newer version.
