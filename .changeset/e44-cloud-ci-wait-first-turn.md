---
"@agentproto/cli": patch
"@agentproto/adapter-claude-code-cloud": patch
---

Fix the Claude Cloud CI lane losing its first `turn-end`. `sessions wait` now accepts `--since <seq>` so a spawn-then-wait caller can replay a turn that finished before the wait process started, and the adapter pre-trusts its cwd so `claude --cloud` cannot stall on the folder-trust dialog.
