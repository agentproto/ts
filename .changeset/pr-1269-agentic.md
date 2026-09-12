---
"@agentproto/adapter-claude-code": patch
"@agentproto/adapter-codex": patch
"@agentproto/adapter-mastracode": patch
"@agentproto/adapter-opencode": patch
"@agentproto/adapter-pi": patch
"@agentproto/cli": patch
---

Replace registry-query version checks (`npm view`) with local presence probes (`npm ls -g` / binary `--version`) so `install` no longer reports "already installed" on machines with nothing installed.
