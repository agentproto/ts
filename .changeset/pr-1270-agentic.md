---
"@agentproto/cli": minor
"@agentproto/adapter-claude-code": patch
"@agentproto/adapter-codex": patch
"@agentproto/adapter-mastracode": patch
"@agentproto/adapter-opencode": patch
"@agentproto/adapter-pi": patch
---

Fix `version_check` to probe local presence (`npm ls -g` / binary `--version`) instead of the npm registry, so `install` no longer reports "already installed" on machines with nothing installed; add read-only freshness tooling: `agentproto adapters outdated` and `agentproto --version --check-updates` (new exported `registry/freshness` module).