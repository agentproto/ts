---
"@agentproto/cli": patch
---

`agentproto doctor` checks that the `agentproto hook inbox` command in `~/.claude/settings.json` resolves in your login shell PATH. When it does not, a `claude` started from that shell prints `agentproto: command not found` on every hook and gets no `cc:` row; the check warns with the fix (a PATH export, or an absolute path in the hook command). With `--fix` it prints the diff that would put the absolute path in the hook commands and does not write it.
