---
"@agentproto/cli": minor
---

Add `agentproto hook install --host claude-desktop`: an idempotent merge of `AGENTPROTO_SESSION_ID` and the `UserPromptSubmit` / `PostToolUse` `agentproto hook inbox` hooks into a Claude settings file, with `--dry-run` to print the merged JSON. The PR already carries an equivalent `.changeset/hook-install-claude-desktop.md`; this is the reviewer's proposed copy so CI can commit it after the review gates.
