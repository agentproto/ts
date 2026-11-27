---
"@agentproto/runtime": patch
---

App sessions for an app installed inside a git repo can read that repo's harness project config again (`.claude/`, `.codex/`, `CLAUDE.md`, `AGENTS.md` at the repo root), read-only. The rest of the hidden host repo stays unreadable, secrets inside `.claude/` stay masked, and nothing in the repo becomes writable. Fixes Claude Code steps starting with "Settings file could not be read: EPERM" and running without the project's hooks and permission rules.
