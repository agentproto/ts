---
"@agentproto/cli": minor
---

Add `agentproto hook install --host claude-desktop`: an idempotent merge of `AGENTPROTO_SESSION_ID` and the `UserPromptSubmit` / `PostToolUse` `agentproto hook inbox` hooks into a Claude Desktop settings file, with `--dry-run` to print the merged JSON. `docs/cli/verbs/hook.md` now documents the full Desktop setup (MCP URL, session id, hooks).
