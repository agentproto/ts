---
"@agentproto/worktree": patch
---

Fix a CI-only flaky test in `lifecycle.test.ts`: generated hook scripts used `process.exit()` right after many `console.log()` calls, which can truncate stdout on a piped (non-TTY) stream before the writes flush. Switched to `process.exitCode = …` so pending output drains before exit. Test-only; no runtime behavior change.
