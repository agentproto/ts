---
"@agentproto/cli": minor
---

New `agentproto hook pr-stamp`: a Claude Code PostToolUse hook that appends the `@agentproto-bot` provenance footer to a PR opened with `gh pr create` by a session the daemon did not spawn (Claude desktop Code tab, plain `claude`). `agentproto hook install --host claude-desktop` now installs it (matcher `Bash`).
