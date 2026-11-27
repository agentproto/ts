---
"@agentproto/runtime": minor
"@agentproto/app": minor
---

App sessions for an app installed inside a git repo can read that repo's root config again, read-only: `.git` (plus the git dirs a linked worktree's `.git` file points at), `.gitignore`, `.claude/`, `.codex/`, `.mcp.json`, `CLAUDE.md` and `AGENTS.md`. Fixes Claude Code steps starting with "Settings file could not be read: EPERM" and running without the project's hooks and permission rules, and `rg` / `git` failing on the hidden `.git` from the app dir.

New `boundaries.hostReads` in APP.md / `defineApp`: paths relative to the host repo root (a sibling package's built CLI, a shared folder) that the app's sessions may read. The loader rejects absolute and `..` entries; the daemon resolves symlinks, refuses entries outside the host repo or naming the whole repo, and masks secret files inside them. Nothing in the host repo becomes writable, and the rest of it stays hidden.
