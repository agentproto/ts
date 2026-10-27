---
"@agentproto/cli": patch
"@agentproto/adapter-claude-code-cloud": patch
---

Fix the Claude Cloud CI lane losing its first `turn-end`. `sessions wait` now accepts `--since <seq>` so a spawn-then-wait caller can replay a turn that finished before the wait process started. The adapter also pre-trusts its cwd without risking the user's config (atomic write, skipped when already trusted, never overwritten on a parse failure) and re-answers a trust dialog that re-renders until it is accepted, so `claude --cloud` cannot stall on the folder-trust prompt.
